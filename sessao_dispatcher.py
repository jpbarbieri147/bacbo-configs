#!/usr/bin/env python3
"""
sessao_dispatcher.py — BacBo Intelligence v4.0
Daemon que roda 24/7 e envia sinais ao Telegram por sessão,
espelhando a lógica do useTelegramMonitor.ts do frontend.

Lê de:  telegram_canais, telegram_session_links, rounds
Envia:  mensagens via Telegram Bot API
"""

import os
import json
import time
import sqlite3
import logging
import requests
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

# ─── Config ───────────────────────────────────────────────────────────────────

DB_PATH      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bacbo_historico.db")
CICLO_SEG    = 5          # intervalo de polling do banco (segundos)
LOG_LEVEL    = logging.INFO
TZ_BRASILIA  = timezone(timedelta(hours=-3))

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [DISPATCHER] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("dispatcher")

# ─── Helpers de banco ─────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn

def load_canais() -> dict:
    """Retorna dict id→canal com todos os canais cadastrados."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM telegram_canais").fetchall()
    return {r["id"]: dict(r) for r in rows}

def load_links() -> list:
    """Retorna todos os links sessão→canal que estão enabled=1."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM telegram_session_links WHERE enabled = 1"
        ).fetchall()
    return [dict(r) for r in rows]

def get_latest_rounds(limit: int = 200) -> list:
    """Retorna as últimas N rodadas ordenadas da mais recente para a mais antiga."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM rounds ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]

# ─── Telegram Bot API ─────────────────────────────────────────────────────────

def send_telegram(token: str, chat_id: str, text: str) -> bool:
    """Envia mensagem via Bot API. Retorna True se sucesso."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(url, json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }, timeout=10)
        if resp.status_code == 200:
            return True
        log.warning(f"Telegram erro {resp.status_code}: {resp.text[:200]}")
        return False
    except Exception as e:
        log.warning(f"Telegram exception: {e}")
        return False

# ─── Lógica de padrão (espelha useTelegramMonitor.ts) ────────────────────────
#
# Cada sessão tem settings salvas no localStorage do frontend — mas o dispatcher
# precisa de uma lógica de detecção simples baseada apenas nos dados do banco.
# Usamos a detecção de padrão de cores (sequências repetidas) como proxy.
# Quando o backend tiver tabela de sinais por sessão, refinar aqui.

CORES = {
    "Banker": "🔴 BANKER",
    "Player": "🔵 PLAYER",
    "Tie":    "🟡 TIE",
}

def detectar_padrao(rounds: list) -> Optional[dict]:
    """
    Detecta padrão simples: se as últimas 3 rodadas foram todas iguais,
    sinaliza a sequência. Retorna dict com alvo e confiança ou None.
    Lógica expansível — substitua por chamada à API de análise se quiser.
    """
    if len(rounds) < 4:
        return None

    # Últimas 3 rodadas (índice 0 = mais recente)
    ultimas = [r["winner"] for r in rounds[:3]]

    # Padrão: 3 iguais seguidas → sinaliza o mesmo resultado de novo
    if ultimas[0] == ultimas[1] == ultimas[2]:
        alvo = ultimas[0]
        return {
            "alvo": alvo,
            "sequencia": ultimas,
            "confianca": 75.0,
            "tipo": "sequencia_3",
        }

    # Padrão alternado: A B A → sinaliza B
    if ultimas[0] != ultimas[1] and ultimas[1] != ultimas[2] and ultimas[0] == ultimas[2]:
        alvo = ultimas[1]
        return {
            "alvo": alvo,
            "sequencia": ultimas,
            "confianca": 70.0,
            "tipo": "alternado",
        }

    return None

# ─── Filtros de despacho ──────────────────────────────────────────────────────

class FiltroState:
    """Estado por sessão para aplicar os filtros de despacho."""
    def __init__(self):
        self.ultimo_envio: Optional[datetime] = None
        self.losses_desde_inicio: int = 0
        self.wins_desde_inicio: int = 0
        self.ultimo_round_id: Optional[str] = None

# Estado global: session_id → FiltroState
_estados: dict[str, FiltroState] = {}

def get_estado(session_id: str) -> FiltroState:
    if session_id not in _estados:
        _estados[session_id] = FiltroState()
    return _estados[session_id]

def parse_filters(filters_json: str) -> dict:
    try:
        return json.loads(filters_json) if filters_json else {}
    except Exception:
        return {}

def filtro_liberado(session_id: str, filters: dict) -> tuple[bool, str]:
    """
    Verifica se os filtros permitem envio agora.
    Retorna (liberado, motivo_bloqueio).
    """
    estado = get_estado(session_id)
    now = datetime.now(TZ_BRASILIA)

    # Filtro janela de tempo
    tw = filters.get("timeWindow", {})
    if tw.get("enabled"):
        minutos = tw.get("minutes", 5)
        if estado.ultimo_envio:
            delta = (now - estado.ultimo_envio).total_seconds() / 60
            if delta < minutos:
                restam = minutos - delta
                return False, f"janela de tempo ({restam:.1f} min restantes)"

    # Filtro após losses
    al = filters.get("afterLoss", {})
    if al.get("enabled"):
        count = al.get("count", 1)
        if estado.losses_desde_inicio < count:
            faltam = count - estado.losses_desde_inicio
            return False, f"aguardando {faltam} loss(es)"

    # Filtro após wins
    aw = filters.get("afterWin", {})
    if aw.get("enabled"):
        count = aw.get("count", 1)
        if estado.wins_desde_inicio < count:
            faltam = count - estado.wins_desde_inicio
            return False, f"aguardando {faltam} win(s)"

    return True, ""

# ─── Formatação da mensagem ───────────────────────────────────────────────────

def formatar_sinal(padrao: dict, session_id: str) -> str:
    alvo = padrao["alvo"]
    emoji_alvo = CORES.get(alvo, alvo)
    seq = " → ".join(CORES.get(c, c) for c in reversed(padrao["sequencia"]))
    conf = padrao["confianca"]
    tipo = "Sequência" if padrao["tipo"] == "sequencia_3" else "Alternância"
    hora = datetime.now(TZ_BRASILIA).strftime("%H:%M:%S")

    return (
        f"🎯 <b>SINAL DETECTADO</b>\n"
        f"━━━━━━━━━━━━━━━\n"
        f"🕐 {hora} (Brasília)\n"
        f"📊 Padrão: {tipo}\n"
        f"🔢 Sequência: {seq}\n"
        f"🎯 Apostar em: <b>{emoji_alvo}</b>\n"
        f"📈 Confiança: {conf:.0f}%\n"
        f"━━━━━━━━━━━━━━━\n"
        f"<i>Sessão: {session_id[:8]}...</i>"
    )

def formatar_resultado(winner: str, alvo: str) -> str:
    acertou = winner == alvo
    emoji = "✅ GREEN" if acertou else "❌ LOSS"
    hora = datetime.now(TZ_BRASILIA).strftime("%H:%M:%S")
    return (
        f"{emoji}\n"
        f"Resultado: {CORES.get(winner, winner)}\n"
        f"Alvo era: {CORES.get(alvo, alvo)}\n"
        f"🕐 {hora}"
    )

# ─── Loop principal ───────────────────────────────────────────────────────────

# Rastreia o último sinal enviado por sessão: session_id → {alvo, round_id, enviado_em}
_sinais_pendentes: dict[str, dict] = {}
# Último round_id processado (para não reprocessar)
_ultimo_round_processado: Optional[str] = None

def ciclo():
    global _ultimo_round_processado

    rounds = get_latest_rounds(200)
    if not rounds:
        return

    round_mais_recente = rounds[0]["gameId"]

    # Nada novo desde o último ciclo
    if round_mais_recente == _ultimo_round_processado:
        return

    _ultimo_round_processado = round_mais_recente

    canais = load_canais()
    links  = load_links()

    if not links:
        return

    # Detectar padrão atual
    padrao = detectar_padrao(rounds)

    for link in links:
        session_id = link["session_id"]
        channel_id = link["channel_id"]
        filters    = parse_filters(link["filters_json"])

        canal = canais.get(channel_id)
        if not canal:
            log.warning(f"Canal {channel_id} não encontrado para sessão {session_id}")
            continue

        token   = canal["token"]
        chat_id = canal["chat_id"]
        estado  = get_estado(session_id)

        # ── Verificar resultado do sinal anterior ──────────────────────────
        pendente = _sinais_pendentes.get(session_id)
        if pendente and pendente.get("round_id") != round_mais_recente:
            winner = rounds[0]["winner"]
            resultado_txt = formatar_resultado(winner, pendente["alvo"])
            send_telegram(token, chat_id, resultado_txt)

            # Atualizar contadores de filtro
            if winner == pendente["alvo"]:
                estado.wins_desde_inicio += 1
            else:
                estado.losses_desde_inicio += 1

            del _sinais_pendentes[session_id]
            log.info(f"[{session_id[:8]}] Resultado enviado: {winner} (alvo={pendente['alvo']})")

        # ── Enviar novo sinal se padrão detectado ──────────────────────────
        if padrao and session_id not in _sinais_pendentes:
            liberado, motivo = filtro_liberado(session_id, filters)
            if not liberado:
                log.debug(f"[{session_id[:8]}] Filtro bloqueou: {motivo}")
                continue

            msg = formatar_sinal(padrao, session_id)
            ok  = send_telegram(token, chat_id, msg)

            if ok:
                _sinais_pendentes[session_id] = {
                    "alvo":     padrao["alvo"],
                    "round_id": round_mais_recente,
                    "enviado_em": datetime.now(TZ_BRASILIA).isoformat(),
                }
                estado.ultimo_envio = datetime.now(TZ_BRASILIA)
                log.info(f"[{session_id[:8]}] Sinal enviado → {padrao['alvo']} (canal={canal['name']})")

def main():
    log.info("=" * 50)
    log.info("BacBo Intelligence — Dispatcher v4.0 iniciado")
    log.info(f"Banco: {DB_PATH}")
    log.info(f"Ciclo: {CICLO_SEG}s")
    log.info("=" * 50)

    while True:
        try:
            ciclo()
        except Exception as e:
            log.error(f"Erro no ciclo: {e}", exc_info=True)
        time.sleep(CICLO_SEG)

if __name__ == "__main__":
    main()
