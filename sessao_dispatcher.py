#!/usr/bin/env python3
"""
sessao_dispatcher.py — BacBo Intelligence v4.1
Tradução fiel e rigorosa de:
  - bacboAnalytics.ts  (analyzePatterns, getCurrentAlerts)
  - useTelegramMonitor.ts (lógica de gale, edição, resultado)
  - telegramService.ts (buildEntryMessage, buildResultMessage)

Lê do banco: rounds, session_settings, telegram_session_links, telegram_canais
NÃO inventa nada. Usa exatamente os mesmos dados e lógica do frontend.
"""

import os
import re
import json
import math
import time
import sqlite3
import logging
import requests
from datetime import datetime, timedelta, timezone
from typing import Optional

# ─── Config ───────────────────────────────────────────────────────────────────

DB_PATH     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bacbo_historico.db")
CICLO_SEG   = 5
TZ_BRASILIA = timezone(timedelta(hours=-3))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [DISPATCHER] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("dispatcher")

# ─── Banco ────────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn

def load_rounds(limit: int = 12000) -> list:
    """
    Retorna rodadas da MAIS ANTIGA para a MAIS RECENTE.
    Campos: id, result (blue/red/tie), number (= Score)
    Espelha exatamente o bacboProvider.ts:
      result: Banker→red, Player→blue, else→tie
      number: item.Score
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT gameId, winner, score, created_at "
            "FROM rounds ORDER BY created_at ASC LIMIT ?", (limit,)
        ).fetchall()
    result = []
    for r in rows:
        w = (r["winner"] or "").strip()
        if w == "Banker":
            res = "red"
        elif w == "Player":
            res = "blue"
        else:
            res = "tie"
        result.append({
            "id":        r["gameId"],
            "result":    res,
            "number":    int(r["score"] or 0),
            "created_at": r["created_at"],
        })
    return result

def load_session_settings() -> dict:
    """Retorna dict session_id → settings (do banco, sincronizado pelo frontend)."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT session_id, settings_json FROM session_settings"
            ).fetchall()
        result = {}
        for r in rows:
            try:
                result[r["session_id"]] = json.loads(r["settings_json"] or "{}")
            except Exception:
                pass
        return result
    except Exception:
        return {}

def load_canais() -> dict:
    """Retorna dict id → canal."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM telegram_canais").fetchall()
    return {r["id"]: dict(r) for r in rows}

def load_links() -> list:
    """Retorna links ativos (enabled=1) com filters parseados."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM telegram_session_links WHERE enabled = 1"
        ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["filters"] = json.loads(d.get("filters_json") or "{}")
        except Exception:
            d["filters"] = {}
        result.append(d)
    return result

# ─── Telegram ─────────────────────────────────────────────────────────────────

def tg_send(token: str, chat_id: str, text: str) -> Optional[int]:
    """Envia mensagem. Retorna message_id ou None."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(url, json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }, timeout=10)
        data = resp.json()
        if data.get("ok"):
            return data["result"]["message_id"]
        log.warning(f"Telegram sendMessage erro: {data.get('description')}")
    except Exception as e:
        log.warning(f"Telegram sendMessage exception: {e}")
    return None

def tg_edit(token: str, chat_id: str, message_id: int, text: str) -> bool:
    """Edita mensagem existente."""
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    try:
        resp = requests.post(url, json={
            "chat_id":    chat_id,
            "message_id": message_id,
            "text":       text,
            "parse_mode": "Markdown",
        }, timeout=10)
        return resp.json().get("ok", False)
    except Exception as e:
        log.warning(f"Telegram editMessage exception: {e}")
    return False

# ─── Motor de padrões — tradução fiel do bacboAnalytics.ts ───────────────────

TARGETS      = ["blue", "red"]
RESULT_ORDER = ["blue", "red", "tie"]

def token_label(r: dict, basis: str) -> str:
    """
    Tradução fiel de tokenFromRound():
      colors  → r.result         ex: "blue"
      numbers → "n{r.number}"    ex: "n7"
      hybrid  → "{result}-{num}" ex: "blue-7"
    """
    if basis == "colors":
        return r["result"]
    elif basis == "numbers":
        return f"n{r['number']}"
    else:  # hybrid
        return f"{r['result']}-{r['number']}"

def resolve_gale(rounds: list, start_idx: int, target: str, gale_level: int) -> Optional[int]:
    """
    Tradução fiel de resolveGale():
    Empate (tie) é considerado GREEN (proteção).
    Retorna o offset (0=SG,1=G1,...) ou None se perdeu.
    """
    for offset in range(gale_level + 1):
        idx = start_idx + offset
        if idx >= len(rounds):
            return None
        r = rounds[idx]
        if r["result"] == target or r["result"] == "tie":
            return offset
    return None

def analyze_patterns(rounds: list, settings: dict) -> list:
    """
    Tradução fiel de analyzePatterns() do bacboAnalytics.ts.
    Sequências de tamanho 3 e 4.
    Filtra por minOccurrences e minAccuracy.
    Ordena por rankingMode.
    """
    basis        = settings.get("basis", "numbers")
    gale_level   = int(settings.get("galeLevel", 1))
    min_occ      = int(settings.get("minOccurrences", 40))
    min_acc      = float(settings.get("minAccuracy", 85))
    ranking_mode = settings.get("rankingMode", "score")

    # Modo "all" — roda as 3 bases e une
    if basis == "all":
        result = []
        for b in ["colors", "numbers", "hybrid"]:
            result.extend(analyze_patterns(rounds, {**settings, "basis": b}))
        return result

    pattern_map = {}

    for size in [3, 4]:
        limit = len(rounds) - size - gale_level
        if limit <= 0:
            continue
        for i in range(limit):
            signal_idx = i + size
            seq_labels = [token_label(rounds[j], basis) for j in range(i, signal_idx)]
            key = "|".join(seq_labels)

            if key not in pattern_map:
                pattern_map[key] = {
                    "seq_labels":  seq_labels,
                    "basis":       basis,
                    "next":        {"blue": 0, "red": 0, "tie": 0},
                    "target_stats": {
                        t: {"hit": 0, "sg_hit": 0, "g1_hit": 0, "g2_hit": 0, "g3_hit": 0}
                        for t in TARGETS
                    },
                    "occurrences": 0,
                }

            acc = pattern_map[key]
            acc["occurrences"] += 1

            next_result = rounds[signal_idx]["result"]
            acc["next"][next_result] += 1

            for target in TARGETS:
                sg = resolve_gale(rounds, signal_idx, target, 0)
                g1 = resolve_gale(rounds, signal_idx, target, 1)
                g2 = resolve_gale(rounds, signal_idx, target, 2)
                g3 = resolve_gale(rounds, signal_idx, target, 3)
                gh = resolve_gale(rounds, signal_idx, target, gale_level)

                ts = acc["target_stats"][target]
                if gh is not None:
                    ts["hit"] += 1
                if sg is not None: ts["sg_hit"] += 1
                if g1 is not None: ts["g1_hit"] += 1
                if g2 is not None: ts["g2_hit"] += 1
                if g3 is not None: ts["g3_hit"] += 1

    insights = []
    for key, acc in pattern_map.items():
        occ = acc["occurrences"]
        if occ < min_occ:
            continue

        # Melhor target (maior accuracy)
        best_target  = None
        best_acc_val = -1.0
        for target in TARGETS:
            acc_val = (acc["target_stats"][target]["hit"] / occ * 100) if occ else 0.0
            if acc_val > best_acc_val:
                best_acc_val = acc_val
                best_target  = target

        if best_acc_val < min_acc:
            continue

        # Score de ranking (igual ao frontend)
        if ranking_mode == "accuracy":
            score = best_acc_val
        elif ranking_mode == "occurrences":
            score = float(occ)
        elif ranking_mode == "sqrt":
            score = best_acc_val * math.sqrt(occ)
        elif ranking_mode == "wilson":
            z = 1.96
            p = best_acc_val / 100.0
            n = occ
            if n > 0:
                z2  = z * z
                num = p + z2/(2*n) - z * math.sqrt((p*(1-p))/n + z2/(4*n*n))
                score = (num / (1 + z2/n)) * 100
            else:
                score = 0.0
        else:  # score (default)
            score = best_acc_val * math.log10(occ + 10)

        insights.append({
            "basis":       acc["basis"],
            "seq_labels":  acc["seq_labels"],
            "occurrences": occ,
            "target":      best_target,
            "accuracy":    best_acc_val,
            "gale_level":  gale_level,
            "score":       score,
        })

    insights.sort(key=lambda x: x["score"], reverse=True)
    return insights

def get_current_alerts(rounds: list, patterns: list, basis: str) -> list:
    """
    Tradução fiel de getCurrentAlerts() do bacboAnalytics.ts.
    Verifica se o tail de rounds bate com a sequência do padrão.
    """
    alerts = []
    bases = ["colors", "numbers", "hybrid"] if basis == "all" else [basis]

    for pattern in patterns:
        b       = pattern["basis"]
        seq_len = len(pattern["seq_labels"])
        if len(rounds) < seq_len:
            continue
        tail = [token_label(r, b) for r in rounds[-seq_len:]]
        if tail == pattern["seq_labels"]:
            alerts.append(pattern)
    return alerts

def get_sample(rounds: list, sample_size: int) -> list:
    """Tradução fiel de getSample()."""
    return rounds[max(0, len(rounds) - sample_size):]

# ─── Mensagens — tradução fiel do telegramService.ts ─────────────────────────

# Emojis por resultado (igual ao TG_DOTS do telegramService.ts)
TG_DOTS = {"blue": "🔵", "red": "🔴", "tie": "🟡"}

RESULT_LABELS = {"blue": "Azul", "red": "Vermelho", "tie": "Empate"}
BASIS_LABELS  = {
    "colors":  "Somente cores",
    "numbers": "Somente números",
    "hybrid":  "Cores + números",
    "all":     "Híbrido (todos)",
}

def seq_text(pattern: dict) -> str:
    """
    Tradução fiel de seqText() do telegramService.ts:
      numbers → *{n}*  (negrito no número)
      colors  → emoji do resultado
      hybrid  → emoji do resultado
    """
    parts = []
    for label in pattern["seq_labels"]:
        if label.startswith("n") and label[1:].isdigit():
            parts.append(f"*{label[1:]}*")
        elif label in TG_DOTS:
            parts.append(TG_DOTS[label])
        else:
            # hybrid: "blue-7" → emoji
            result_part = label.split("-")[0]
            parts.append(TG_DOTS.get(result_part, label))
    return " → ".join(parts)

def format_percent(val: float) -> str:
    return f"{val:.1f}%"

def build_entry_message(pattern: dict, gale_status: str) -> str:
    """
    Tradução fiel de buildEntryMessage() do telegramService.ts.
    gale_status: "sg" | "g1" | "g2" | "g3" |
                 "green_sg" | "green_g1" | "green_g2" | "green_g3" |
                 "tie_sg" | "tie_g1" | "tie_g2" | "tie_g3" | "loss"
    """
    target_dot   = TG_DOTS.get(pattern["target"], "")
    target_label = RESULT_LABELS.get(pattern["target"], pattern["target"])

    status_map = {
        "sg":       "🔄 *Aguardando SG...*",
        "g1":       "🔄 *SG não converteu — Aguardando G1...*",
        "g2":       "🔄 *G1 não converteu — Aguardando G2...*",
        "g3":       "🔄 *G2 não converteu — Aguardando G3...*",
        "green_sg": "✅ *GREEN SG*",
        "green_g1": "✅ *GREEN G1*",
        "green_g2": "✅ *GREEN G2*",
        "green_g3": "✅ *GREEN G3*",
        "tie_sg":   "✅ *GREEN EMPATE SG*",
        "tie_g1":   "✅ *GREEN EMPATE G1*",
        "tie_g2":   "✅ *GREEN EMPATE G2*",
        "tie_g3":   "✅ *GREEN EMPATE G3*",
        "loss":     "❌ *LOSS — Siga a gestão!*",
    }
    status_line = status_map.get(gale_status, "🔄 *Aguardando...*")

    lines = [
        "🎯 *SINAL DETECTADO*",
        "",
        f"📋 *Sequência:* {seq_text(pattern)}",
        f"🎲 *Base:* {BASIS_LABELS.get(pattern['basis'], pattern['basis'])}",
        f"*Entrar em:* {target_dot} *{target_label}*",
        f"📊 *Assertividade:* {format_percent(pattern['accuracy'])}",
        f"🔢 *Ocorrências:* {pattern['occurrences']:,}".replace(",", "."),
        "",
        status_line,
    ]
    return "\n".join(lines)

def build_result_message(result_type: str) -> str:
    """Tradução fiel de buildResultMessage() do telegramService.ts."""
    if result_type == "loss":
        return "❌ *LOSS* — Siga a gestão!"
    if result_type.startswith("tie_"):
        gale = result_type.split("_")[1].upper()
        return f"✅ *GREEN EMPATE {gale}*"
    return f"✅ *GREEN {result_type.upper()}*"

# ─── Filtros — tradução fiel de shouldDispatch() do telegramService.ts ───────

class GateState:
    def __init__(self):
        self.last_window_id: Optional[int]  = None
        self.last_resolved_entry_id: Optional[str] = None

def should_dispatch(filters: dict, history: list, gate: GateState, now_ms: int) -> bool:
    """
    Tradução fiel de shouldDispatch() do telegramService.ts.
    history: lista de dicts com {id, result} — mais antigo primeiro.
    Lógica E: todos os filtros ativos precisam liberar.
    """
    time_ok   = True
    window_id = None

    tw = filters.get("timeWindow", {})
    if tw.get("enabled"):
        ms        = int(tw.get("minutes", 30)) * 60 * 1000
        window_id = now_ms // ms
        time_ok   = gate.last_window_id != window_id

    loss_ok = True
    win_ok  = True
    al = filters.get("afterLoss", {})
    aw = filters.get("afterWin",  {})

    if al.get("enabled") or aw.get("enabled"):
        start_idx = 0
        if gate.last_resolved_entry_id:
            for i, h in enumerate(history):
                if h["id"] == gate.last_resolved_entry_id:
                    start_idx = i + 1
                    break
        since      = history[start_idx:]
        loss_count = sum(1 for h in since if h["result"] == "loss")
        win_count  = sum(1 for h in since if h["result"] != "loss")
        if al.get("enabled"):
            loss_ok = loss_count >= int(al.get("count", 1))
        if aw.get("enabled"):
            win_ok  = win_count  >= int(aw.get("count", 1))

    passed = time_ok and loss_ok and win_ok

    if passed:
        if window_id is not None:
            gate.last_window_id = window_id
        if history:
            gate.last_resolved_entry_id = history[-1]["id"]

    return passed

# ─── Estado por sessão ────────────────────────────────────────────────────────

class SessionState:
    def __init__(self):
        self.initialized        = False
        self.monitor_start_len  = 0      # len(sample) quando inicializou
        self.last_sample_len    = 0      # para detectar nova rodada
        self.resolved_keys      = set()  # alert_keys já resolvidos
        self.pending            = None   # sinal aguardando resultado
        self.gate               = GateState()
        self.dispatch_history   = []     # [{id, result}] para os filtros

_estados: dict[str, SessionState] = {}

def get_estado(session_id: str) -> SessionState:
    if session_id not in _estados:
        _estados[session_id] = SessionState()
    return _estados[session_id]

# ─── Loop principal ───────────────────────────────────────────────────────────

def ciclo(all_rounds: list, canais: dict, links: list, all_settings: dict):
    for link in links:
        session_id = link["session_id"]
        channel_id = link["channel_id"]
        filters    = link["filters"]

        canal = canais.get(channel_id)
        if not canal:
            log.warning(f"[{session_id[:8]}] Canal {channel_id} não encontrado")
            continue

        token   = canal["token"]
        chat_id = canal["chat_id"]

        settings = all_settings.get(session_id)
        if not settings:
            log.debug(f"[{session_id[:8]}] Settings não encontradas no banco ainda")
            continue

        sample = get_sample(all_rounds, int(settings.get("sampleSize", 10000)))
        estado = get_estado(session_id)

        # ── Inicialização: registra ponto de partida ───────────────────────
        if not estado.initialized:
            estado.monitor_start_len = len(sample)
            estado.last_sample_len   = len(sample)
            estado.initialized       = True
            log.info(f"[{session_id[:8]}] Inicializado com {len(sample)} rodadas "
                     f"| {settings.get('basis')} G{settings.get('galeLevel')} "
                     f"{settings.get('minAccuracy')}% {settings.get('minOccurrences')}occ")
            continue

        # ── Nada novo desde o último ciclo ────────────────────────────────
        if len(sample) == estado.last_sample_len:
            continue

        # ── Verificar resultado do sinal pendente ─────────────────────────
        if estado.pending:
            pending       = estado.pending
            result_rounds = sample[pending["result_start_idx"]:]

            if result_rounds:
                target     = pending["pattern"]["target"]
                gale_level = pending["pattern"]["gale_level"]
                gale_count = 0
                tie_before = False

                for rr in result_rounds:
                    if rr["result"] == "tie":
                        tie_before = True
                        continue

                    if rr["result"] == target:
                        # ✅ GREEN
                        gale_label  = ["sg","g1","g2","g3"][min(gale_count, 3)]
                        result_type = f"tie_{gale_label}" if tie_before else f"green_{gale_label}"

                        # Edita MSG 1 com resultado final
                        final_txt = build_entry_message(pending["pattern"], result_type)
                        if pending.get("message_id"):
                            tg_edit(token, chat_id, pending["message_id"], final_txt)

                        estado.resolved_keys.add(pending["alert_key"])
                        estado.dispatch_history.append({"id": pending["alert_key"], "result": "green"})
                        log.info(f"[{session_id[:8]}] ✅ {result_type.upper()}")
                        estado.pending = None
                        break

                    # Errou — consome gale
                    gale_count += 1

                    if gale_count > gale_level:
                        non_tie = [r for r in result_rounds if r["result"] != "tie"]
                        if len(non_tie) < gale_level + 1:
                            break
                        # ❌ LOSS
                        result_type = "tie_sg" if tie_before else "loss"
                        final_txt   = build_entry_message(pending["pattern"], result_type)
                        if pending.get("message_id"):
                            tg_edit(token, chat_id, pending["message_id"], final_txt)

                        estado.resolved_keys.add(pending["alert_key"])
                        estado.dispatch_history.append({"id": pending["alert_key"], "result": "loss"})
                        log.info(f"[{session_id[:8]}] ❌ LOSS")
                        estado.pending = None
                        break

                    # Ainda tem gale — edita MSG 1
                    next_gale = ["sg","g1","g2","g3"][min(gale_count, 3)]
                    if pending.get("current_gale") != next_gale and pending.get("message_id"):
                        pending["current_gale"] = next_gale
                        edit_txt = build_entry_message(pending["pattern"], next_gale)
                        tg_edit(token, chat_id, pending["message_id"], edit_txt)
                        log.info(f"[{session_id[:8]}] Editado → {next_gale.upper()}")

        estado.last_sample_len = len(sample)

        # Sinal pendente ainda em aberto — aguarda resultado
        if estado.pending:
            continue

        # ── Detectar novo padrão ───────────────────────────────────────────
        patterns = analyze_patterns(sample, settings)
        alerts   = get_current_alerts(sample, patterns, settings.get("basis", "numbers"))

        if not alerts:
            continue

        alert     = alerts[0]
        alert_key = f"{alert['basis']}:{'|'.join(alert['seq_labels'])}"

        if alert_key in estado.resolved_keys:
            continue

        # Sequência deve ter começado APÓS a inicialização
        seq_len       = len(alert["seq_labels"])
        seq_first_idx = len(sample) - seq_len
        if seq_first_idx < estado.monitor_start_len:
            continue

        # Aplicar filtros
        now_ms  = int(time.time() * 1000)
        liberado = should_dispatch(filters, estado.dispatch_history, estado.gate, now_ms)
        if not liberado:
            log.debug(f"[{session_id[:8]}] Filtro bloqueou sinal")
            continue

        # Enviar MSG 1
        msg = build_entry_message(alert, "sg")
        mid = tg_send(token, chat_id, msg)

        if mid:
            estado.pending = {
                "pattern":          alert,
                "alert_key":        alert_key,
                "message_id":       mid,
                "result_start_idx": len(sample),
                "current_gale":     "sg",
            }
            log.info(f"[{session_id[:8]}] Sinal enviado → {alert['target']} "
                     f"({alert['basis']}, {alert['accuracy']:.1f}%, "
                     f"{alert['occurrences']}occ, canal={canal['name']})")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    log.info("=" * 60)
    log.info("BacBo Intelligence — Dispatcher v4.1 (motor real)")
    log.info(f"Banco: {DB_PATH}")
    log.info(f"Ciclo: {CICLO_SEG}s")
    log.info("=" * 60)

    while True:
        try:
            all_rounds   = load_rounds(12000)
            canais       = load_canais()
            links        = load_links()
            all_settings = load_session_settings()

            if links and all_settings:
                ciclo(all_rounds, canais, links, all_settings)

        except Exception as e:
            log.error(f"Erro no ciclo principal: {e}", exc_info=True)

        time.sleep(CICLO_SEG)

if __name__ == "__main__":
    main()
