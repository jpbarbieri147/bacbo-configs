"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BASIS_LABELS,
  RESULT_LABELS,
  type PatternBasis,
  type PatternSettings,
} from "@/lib/bacboAnalytics";
import { formatPercent, formatTime } from "@/lib/utils";
import type { HistoryEntry } from "@/components/bacbo/pattern-formation-box";
import { BookMarked, Download, Trash2, ChevronDown, ChevronUp, Radio, Send, X, Settings, Clock, TrendingDown, TrendingUp, Pencil, Check, BookOpen, AlertTriangle } from "lucide-react";
import {
  loadChannels,
  loadSessionLink,
  saveSessionLink,
  saveChannels,
  testChannel,
  defaultDispatchFilters,
  type TelegramChannel,
  type SessionTelegramLink,
  type DispatchFilters,
} from "@/lib/telegramService";

// ─── URL base da API ──────────────────────────────────────────────────────────
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://187.127.38.39:5000";

// ─── Sincroniza link sessão→canal com o banco da VPS ─────────────────────────
async function syncLinkComBanco(
  sessionId: string,
  link: SessionTelegramLink,
): Promise<void> {
  try {
    await fetch(`${API_BASE}/sessoes/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, link }),
    });
  } catch (err) {
    console.warn("[SessionHistory] Falha ao sincronizar link com o banco:", err);
  }
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SavedSession {
  id: string;
  createdAt: string;
  label: string;
  name?: string;
  diaryEnabled?: boolean;
  settings: PatternSettings;
  history: HistoryEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BALL_COLORS: Record<string, { bg: string; border: string }> = {
  red:  { bg: "#c0392b", border: "#ff4d57" },
  blue: { bg: "#1a5fa8", border: "#2f7dff" },
  tie:  { bg: "#b8860b", border: "#f0c040" },
};

const BASIS_BADGE_STYLE: Record<PatternBasis, string> = {
  colors:  "border-blue-400/40 bg-blue-400/10 text-blue-400",
  numbers: "border-purple-400/40 bg-purple-400/10 text-purple-400",
  hybrid:  "border-teal-400/40 bg-teal-400/10 text-teal-400",
  all:     "border-primary/40 bg-primary/10 text-primary",
};

function settingsLabel(s: PatternSettings): string {
  const base = BASIS_LABELS[s.basis];
  const gale = s.galeLevel === 0 ? "SG" : `G${s.galeLevel}`;
  return `${base} · ${(s.sampleSize / 1000).toFixed(0)}k · ${s.minOccurrences}occ · ${s.minAccuracy}% · ${gale}`;
}

function exportCSV(session: SavedSession) {
  const maxSeqLen = session.history.reduce((max, e) => Math.max(max, e.sequence.length), 0);
  const seqHeaders = Array.from({ length: maxSeqLen }, (_, i) => `Sequência ${i + 1}`);
  const headers = ["Dia", "Horário", "Base", ...seqHeaders, "Alvo", "Assertividade", "Ocorrências", "Resultado"];

  const rows = session.history.map(e => {
    const date = new Date(e.timestamp);
    const locale = "pt-BR";
    const tz = { timeZone: "America/Sao_Paulo" } as const;
    const dia     = date.toLocaleDateString(locale, { ...tz, day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
    const horario = date.toLocaleTimeString(locale, { ...tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const seqCols = Array.from({ length: maxSeqLen }, (_, i) => e.sequence[i] ? e.sequence[i].label : "");
    const resultado = e.result === "loss" ? "Loss" : e.result === "green-g0" ? "Green SG" : `Green ${e.result.replace("green-", "").toUpperCase()}`;
    return [dia, horario, BASIS_LABELS[e.basis], ...seqCols, RESULT_LABELS[e.target], `${formatPercent(e.accuracy)}`, String(e.occurrences), resultado];
  });

  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bacbo-sessao-${session.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Modal de filtros de despacho ─────────────────────────────────────────────

function DispatchFiltersModal({
  sessionId,
  link,
  onChange,
  onClose,
}: {
  sessionId: string;
  link: SessionTelegramLink;
  onChange: (link: SessionTelegramLink) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<DispatchFilters>(
    link.filters ?? defaultDispatchFilters(),
  );

  function save() {
    const next = { ...link, filters };
    saveSessionLink(sessionId, next);
    syncLinkComBanco(sessionId, next); // ← PATCH: sincroniza filtros com o banco
    onChange(next);
    onClose();
  }

  const anyOn = filters.timeWindow.enabled || filters.afterLoss.enabled || filters.afterWin.enabled;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/[0.1] bg-[#15161c] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Filtros de envio ao Telegram</h3>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/[0.05] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Reduza o volume de sinais no Telegram. O histórico da sessão continua
            registrando <strong className="text-foreground">todos</strong> os padrões —
            estes filtros controlam apenas o que é <strong className="text-foreground">enviado</strong>.
            Filtros combinados exigem que <strong className="text-foreground">todos</strong> liberem.
          </p>

          <FilterRow
            icon={<Clock className="h-4 w-4" />}
            title="Janela de tempo"
            desc="1 sinal por janela fixa de relógio"
            enabled={filters.timeWindow.enabled}
            onToggle={(v) => setFilters((f) => ({ ...f, timeWindow: { ...f.timeWindow, enabled: v } }))}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">A cada</span>
              <input
                type="number" min={1} max={240}
                value={filters.timeWindow.minutes}
                onChange={(e) => setFilters((f) => ({ ...f, timeWindow: { ...f.timeWindow, minutes: Math.max(1, Number(e.target.value) || 1) } }))}
                className="w-16 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-xs text-foreground text-center tabular-nums focus:outline-none focus:border-primary/50"
              />
              <span className="text-xs text-muted-foreground">minutos</span>
            </div>
          </FilterRow>

          <FilterRow
            icon={<TrendingDown className="h-4 w-4" />}
            title="Após losses"
            desc="Envia só depois de N losses na sessão"
            enabled={filters.afterLoss.enabled}
            onToggle={(v) => setFilters((f) => ({ ...f, afterLoss: { ...f.afterLoss, enabled: v } }))}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Após</span>
              <input
                type="number" min={1} max={50}
                value={filters.afterLoss.count}
                onChange={(e) => setFilters((f) => ({ ...f, afterLoss: { ...f.afterLoss, count: Math.max(1, Number(e.target.value) || 1) } }))}
                className="w-16 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-xs text-foreground text-center tabular-nums focus:outline-none focus:border-primary/50"
              />
              <span className="text-xs text-muted-foreground">loss(es)</span>
            </div>
          </FilterRow>

          <FilterRow
            icon={<TrendingUp className="h-4 w-4" />}
            title="Após wins"
            desc="Envia só depois de N greens na sessão"
            enabled={filters.afterWin.enabled}
            onToggle={(v) => setFilters((f) => ({ ...f, afterWin: { ...f.afterWin, enabled: v } }))}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Após</span>
              <input
                type="number" min={1} max={50}
                value={filters.afterWin.count}
                onChange={(e) => setFilters((f) => ({ ...f, afterWin: { ...f.afterWin, count: Math.max(1, Number(e.target.value) || 1) } }))}
                className="w-16 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2 py-1 text-xs text-foreground text-center tabular-nums focus:outline-none focus:border-primary/50"
              />
              <span className="text-xs text-muted-foreground">green(s)</span>
            </div>
          </FilterRow>

          {!anyOn && (
            <p className="text-[11px] text-muted-foreground/70 italic">
              Nenhum filtro ativo — todos os sinais são enviados normalmente.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.07]">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs h-8">Cancelar</Button>
          <Button size="sm" onClick={save} className="text-xs h-8">Salvar filtros</Button>
        </div>
      </div>
    </div>
  );
}

function FilterRow({
  icon, title, desc, enabled, onToggle, children,
}: {
  icon: ReactNode; title: string; desc: string;
  enabled: boolean; onToggle: (v: boolean) => void; children: ReactNode;
}) {
  return (
    <div className={`rounded-xl border p-3 transition-colors ${enabled ? "border-primary/30 bg-primary/[0.04]" : "border-white/[0.07] bg-white/[0.01]"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={enabled ? "text-primary" : "text-muted-foreground"}>{icon}</span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{title}</p>
            <p className="text-[11px] text-muted-foreground truncate">{desc}</p>
          </div>
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? "bg-primary" : "bg-white/[0.1]"}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : "translate-x-0"}`} />
        </button>
      </div>
      {enabled && <div className="mt-3 pl-7">{children}</div>}
    </div>
  );
}

// ─── Botão de despacho Telegram (por sessão) ──────────────────────────────────

function TelegramDispatchButton({
  sessionId, channels, link, onChange, onChannelsChange,
}: {
  sessionId: string;
  channels: TelegramChannel[];
  link: SessionTelegramLink;
  onChange: (link: SessionTelegramLink) => void;
  onChannelsChange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeChannel = link.enabled && link.channelId
    ? channels.find((c) => c.id === link.channelId) ?? null
    : null;

  function handleMainClick() {
    if (activeChannel) {
      const next = { enabled: false, channelId: link.channelId };
      saveSessionLink(sessionId, next);
      syncLinkComBanco(sessionId, next); // ← PATCH: desativação sincroniza com o banco
      onChange(next);
      setOpen(false);
    } else {
      setOpen((o) => !o);
    }
  }

  async function pick(channelId: string) {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) return;
    setTestingId(channelId);
    const ok = await testChannel(channel);

    const updated = channels.map((c) =>
      c.id === channelId ? { ...c, status: (ok ? "ok" : "error") as TelegramChannel["status"] } : c,
    );
    saveChannels(updated);
    onChannelsChange?.();
    setTestingId(null);

    if (ok) {
      const next = { enabled: true, channelId };
      saveSessionLink(sessionId, next);
      syncLinkComBanco(sessionId, next); // ← PATCH: ativação sincroniza com o banco
      onChange(next);
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm" variant="ghost"
        onClick={handleMainClick}
        className={`text-xs h-7 px-2 gap-1 transition-colors ${
          activeChannel
            ? "text-emerald-400 bg-emerald-400/10 hover:bg-emerald-400/15"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title={activeChannel ? `Enviando para ${activeChannel.name} — clique para desativar` : "Enviar sinais ao Telegram"}
      >
        <Send className="h-3.5 w-3.5" />
        {activeChannel && <span className="max-w-[88px] truncate">{activeChannel.name}</span>}
        <span className={`h-1.5 w-1.5 rounded-full ${activeChannel ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
      </Button>

      {open && !activeChannel && (
        <div className="absolute right-0 top-9 z-20 w-60 rounded-xl border border-white/[0.1] bg-[#15161c] shadow-xl p-1.5">
          <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">Testar e enviar sinais para:</p>
          {channels.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Nenhum canal criado. Crie um na aba <strong className="text-foreground">Telegram</strong>.
            </p>
          ) : (
            <div className="space-y-0.5">
              {channels.map((c) => {
                const isTesting = testingId === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => pick(c.id)}
                    disabled={isTesting}
                    className="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-white/[0.05] transition-colors disabled:opacity-50"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${c.status === "ok" ? "bg-emerald-400" : c.status === "error" ? "bg-destructive" : "bg-muted-foreground/40"}`} />
                      <span className="truncate">{c.name}</span>
                    </span>
                    {isTesting
                      ? <span className="text-[10px] text-muted-foreground shrink-0">testando</span>
                      : c.status === "error"
                        ? <X className="h-3.5 w-3.5 text-destructive shrink-0" />
                        : <Send className="h-3 w-3 text-muted-foreground shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Nome editável inline da sessão ───────────────────────────────────────────

function EditableSessionName({ name, label, onRename }: { name: string | undefined; label: string; onRename: (name: string) => void; }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name ?? "");
      const id = window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
      return () => window.clearTimeout(id);
    }
  }, [editing, name]);

  function commit() { onRename(draft.trim()); setEditing(false); }
  function cancel() { setDraft(name ?? ""); setEditing(false); }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <input
          ref={inputRef} value={draft} maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
          onBlur={commit}
          placeholder="Nomeie esta estratégia"
          className="flex-1 min-w-0 rounded-lg border border-primary/40 bg-white/[0.04] px-2.5 py-1 text-sm font-medium text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <button onClick={commit} className="h-6 w-6 flex items-center justify-center rounded-md text-primary hover:bg-primary/10 transition-colors shrink-0" title="Salvar (Enter)">
          <Check className="h-3.5 w-3.5" />
        </button>
        <button onClick={cancel} className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.05] hover:text-foreground transition-colors shrink-0" title="Cancelar (Esc)">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (name) {
    return (
      <div className="group flex items-center gap-1.5 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{name}</p>
        <button onClick={() => setEditing(true)} className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-white/[0.05] transition-all" title="Renomear">
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 min-w-0">
      <p className="text-sm font-medium text-foreground truncate">{label}</p>
      <button onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:text-muted-foreground transition-all" title="Dar um nome a esta sessão">
        <Pencil className="h-2.5 w-2.5" />
        Nomear
      </button>
    </div>
  );
}

// ─── Modal de confirmação de desativação do Diário ────────────────────────────

function DiaryDisableModal({ sessionName, onPause, onDeleteAll, onCancel, deleting }: {
  sessionName: string; onPause: () => void; onDeleteAll: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.1] bg-[#15161c] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-white/[0.07]">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-amber-400">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Desativar Diário</h3>
            <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
              O que deseja fazer com os dados de <strong className="text-foreground">{sessionName}</strong> já registrados?
            </p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-2.5">
          <button onClick={onPause} disabled={deleting} className="w-full flex items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.14] px-4 py-3 text-left transition-colors disabled:opacity-50">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><BookOpen className="h-3.5 w-3.5" /></span>
            <div>
              <p className="text-xs font-semibold text-foreground">Só pausar</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">Para novos envios, mas mantém os dados já gravados no Diário intactos.</p>
            </div>
          </button>
          <button onClick={onDeleteAll} disabled={deleting} className="w-full flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/[0.05] hover:bg-destructive/[0.10] hover:border-destructive/40 px-4 py-3 text-left transition-colors disabled:opacity-50">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              {deleting ? <span className="h-3.5 w-3.5 rounded-full border-2 border-destructive/40 border-t-destructive animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </span>
            <div>
              <p className="text-xs font-semibold text-destructive">Apagar tudo e desativar</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">Remove todos os registros desta sessão do Diário. <strong className="text-destructive/80">Não tem volta.</strong></p>
            </div>
          </button>
        </div>
        <div className="flex justify-end px-5 pb-5">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={deleting} className="text-xs h-8">Cancelar</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Botão de toggle do Diário de Performance ─────────────────────────────────

function DiaryToggleButton({ hasName, enabled, sessionName, sessionId, onEnable, onPause, onDeleteAll }: {
  hasName: boolean; enabled: boolean; sessionName: string; sessionId: string;
  onEnable: () => void; onPause: () => void; onDeleteAll: (sessionId: string) => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function handleClick() {
    if (!hasName) return;
    if (!enabled) { onEnable(); } else { setModalOpen(true); }
  }

  function handlePause() { onPause(); setModalOpen(false); }

  async function handleDeleteAll() {
    setDeleting(true);
    try { await onDeleteAll(sessionId); onPause(); }
    finally { setDeleting(false); setModalOpen(false); }
  }

  return (
    <>
      <button
        onClick={handleClick} disabled={!hasName}
        className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
          !hasName ? "text-muted-foreground/40 cursor-not-allowed"
          : enabled ? "text-primary bg-primary/10 hover:bg-primary/15"
          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]"
        }`}
        title={!hasName ? "Nomeie a sessão antes de registrar no Diário" : enabled ? "Registrando no Diário — clique para gerenciar" : "Clique para registrar esta sessão no Diário"}
      >
        <BookOpen className="h-3.5 w-3.5" />
      </button>
      {modalOpen && (
        <DiaryDisableModal
          sessionName={sessionName} onPause={handlePause}
          onDeleteAll={handleDeleteAll} onCancel={() => setModalOpen(false)} deleting={deleting}
        />
      )}
    </>
  );
}

// ─── SessionCard ──────────────────────────────────────────────────────────────

function SessionCard({
  session, isCollecting, liveHistory, channels, telegramLink,
  onTelegramChange, onChannelsChange, onToggleCollecting, onDelete,
  onClearHistory, onRename, onEnableDiary, onPauseDiary, onDeleteAllDiary,
}: {
  session: SavedSession; isCollecting: boolean; liveHistory: HistoryEntry[] | undefined;
  channels: TelegramChannel[]; telegramLink: SessionTelegramLink;
  onTelegramChange: (link: SessionTelegramLink) => void; onChannelsChange?: () => void;
  onToggleCollecting: () => void; onDelete: () => void; onClearHistory: () => void;
  onRename: (name: string) => void; onEnableDiary: () => void; onPauseDiary: () => void;
  onDeleteAllDiary: (sessionId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const history = liveHistory ?? session.history;
  const greens = history.filter(e => e.result !== "loss").length;
  const losses = history.filter(e => e.result === "loss").length;
  const winRate = history.length > 0 ? (greens / history.length) * 100 : 0;

  let maxDD = 0, curDD = 0;
  for (const e of [...history].reverse()) {
    if (e.result === "loss") { curDD++; maxDD = Math.max(maxDD, curDD); } else curDD = 0;
  }

  return (
    <div className={`rounded-2xl border transition-colors ${isCollecting ? "border-primary/40 bg-primary/[0.06]" : "border-white/[0.07] bg-white/[0.02]"}`}>
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {isCollecting && (
            <span className="flex items-center gap-1 text-xs text-primary font-medium shrink-0">
              <Radio className="h-3 w-3 animate-pulse" /> Coletando
            </span>
          )}
          <div className="min-w-0 flex-1">
            <EditableSessionName name={session.name} label={session.label} onRename={onRename} />
            <p className="text-xs text-muted-foreground mt-0.5">
              {session.name && (
                <>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">{session.label}</span>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                </>
              )}
              {new Date(session.createdAt).toLocaleString("pt-BR")} · {history.length} disparo{history.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-4 shrink-0 text-sm">
          <span className="text-primary font-semibold">{greens}G</span>
          <span className="text-destructive font-semibold">{losses}L</span>
          {history.length > 0 && (
            <span className={`font-semibold ${winRate >= 80 ? "text-primary" : winRate >= 70 ? "text-amber-400" : "text-destructive"}`}>
              {formatPercent(winRate)}
            </span>
          )}
          {history.length > 0 && <span className="text-muted-foreground text-xs">MaxDD {maxDD}</span>}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant={isCollecting ? "default" : "outline"} onClick={onToggleCollecting} className="text-xs h-7 px-2">
            {isCollecting ? "Coletando" : "Coletar"}
          </Button>
          {isCollecting && (
            <TelegramDispatchButton sessionId={session.id} channels={channels} link={telegramLink} onChange={onTelegramChange} onChannelsChange={onChannelsChange} />
          )}
          {isCollecting && (
            <DiaryToggleButton
              hasName={!!(session.name && session.name.trim().length > 0)}
              enabled={!!session.diaryEnabled} sessionName={session.name ?? session.label}
              sessionId={session.id} onEnable={onEnableDiary} onPause={onPauseDiary} onDeleteAll={onDeleteAllDiary}
            />
          )}
          {isCollecting && telegramLink.enabled && (
            <button
              onClick={() => setFiltersOpen(true)}
              className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
                (telegramLink.filters?.timeWindow.enabled || telegramLink.filters?.afterLoss.enabled || telegramLink.filters?.afterWin.enabled)
                  ? "text-primary bg-primary/10 hover:bg-primary/15"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Filtros de envio ao Telegram"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
          {history.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => exportCSV({ ...session, history })} className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground" title="Exportar CSV">
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          <button onClick={() => setOpen(o => !o)} className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <button onClick={onDelete} className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors" title="Excluir sessão">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-3 space-y-3">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground items-center">
            <span>Base: <strong className="text-foreground">{BASIS_LABELS[session.settings.basis]}</strong></span>
            <span>·</span>
            <span>Janela: <strong className="text-foreground">{(session.settings.sampleSize/1000).toFixed(0)}k</strong></span>
            <span>·</span>
            <span>MinOcc: <strong className="text-foreground">{session.settings.minOccurrences}</strong></span>
            <span>·</span>
            <span>Assert.: <strong className="text-foreground">{session.settings.minAccuracy}%</strong></span>
            <span>·</span>
            <span>Gale: <strong className="text-foreground">{session.settings.galeLevel === 0 ? "SG" : `G${session.settings.galeLevel}`}</strong></span>
            <span>·</span>
            <span>Ranking: <strong className="text-foreground">{session.settings.rankingMode}</strong></span>
            {history.length > 0 && (
              <button onClick={onClearHistory} className="ml-auto text-xs text-muted-foreground hover:text-destructive underline">Limpar histórico</button>
            )}
          </div>

          {history.length > 0 && (
            <div className="sm:hidden flex gap-4 text-sm">
              <span className="text-primary font-semibold">{greens} greens</span>
              <span className="text-destructive font-semibold">{losses} losses</span>
              <span className={`font-semibold ${winRate >= 80 ? "text-primary" : "text-amber-400"}`}>{formatPercent(winRate)}</span>
              <span className="text-muted-foreground text-xs">MaxDD {maxDD}</span>
            </div>
          )}

          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum padrão registrado ainda. Ative esta sessão para começar a acumular.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/[0.07]">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead className="bg-white/[0.04] text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2.5 font-medium">Horário</th>
                    <th className="p-2.5 font-medium">Base</th>
                    <th className="p-2.5 font-medium">Sequência</th>
                    <th className="p-2.5 font-medium">Alvo</th>
                    <th className="p-2.5 font-medium">Assert.</th>
                    <th className="p-2.5 font-medium">Ocorr.</th>
                    <th className="p-2.5 font-medium">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-t border-white/[0.05] hover:bg-white/[0.02] transition-colors">
                      <td className="p-2.5 text-xs text-muted-foreground whitespace-nowrap">{formatTime(entry.timestamp)}</td>
                      <td className="p-2.5">
                        <Badge className={BASIS_BADGE_STYLE[entry.basis]}>
                          {entry.basis === "colors" ? "Cores" : entry.basis === "numbers" ? "Núms." : "C+N"}
                        </Badge>
                      </td>
                      <td className="p-2.5">
                        <div className="flex gap-1">
                          {entry.sequence.map((t, i) => {
                            const c = t.result ? BALL_COLORS[t.result] : { bg: "#333", border: "#555" };
                            return (
                              <div key={i} style={{
                                width: 22, height: 22, borderRadius: "50%",
                                background: `radial-gradient(circle at 35% 35%, ${c.border}, ${c.bg})`,
                                border: `1.5px solid ${c.border}`,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 8, fontWeight: 700, color: "#fff", fontFamily: "monospace",
                              }}>
                                {t.number ?? ""}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                      <td className="p-2.5 whitespace-nowrap">
                        <span style={{
                          width: 20, height: 20, borderRadius: "50%",
                          background: `radial-gradient(circle at 35% 35%, ${BALL_COLORS[entry.target]?.border ?? "#666"}, ${BALL_COLORS[entry.target]?.bg ?? "#333"})`,
                          border: `1.5px solid ${BALL_COLORS[entry.target]?.border ?? "#666"}`,
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          marginRight: 6, verticalAlign: "middle",
                        }} />
                        {RESULT_LABELS[entry.target]}
                      </td>
                      <td className="p-2.5 tabular-nums">{formatPercent(entry.accuracy)}</td>
                      <td className="p-2.5 tabular-nums text-muted-foreground">{entry.occurrences.toLocaleString("pt-BR")}</td>
                      <td className="p-2.5">
                        <Badge className={
                          entry.result === "loss" ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : entry.result === "green-g0" ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-amber-400/40 bg-amber-400/10 text-amber-400"
                        }>
                          {entry.result === "loss" ? "Loss" : entry.result === "green-g0" ? "Green SG" : `Green ${entry.result.replace("green-", "").toUpperCase()}`}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {filtersOpen && (
        <DispatchFiltersModal sessionId={session.id} link={telegramLink} onChange={onTelegramChange} onClose={() => setFiltersOpen(false)} />
      )}
    </div>
  );
}

// ─── SessionsTab ──────────────────────────────────────────────────────────────

interface SessionsTabProps {
  sessions: SavedSession[];
  collectingIds: string[];
  sessionHistories: Record<string, HistoryEntry[]>;
  onToggleCollecting: (id: string) => void;
  onDelete: (id: string) => void;
  onClearHistory: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onEnableDiary: (id: string) => void;
  onPauseDiary: (id: string) => void;
  onDeleteAllDiary: (id: string) => Promise<void>;
}

export function SessionsTab({
  sessions, collectingIds, sessionHistories, onToggleCollecting, onDelete,
  onClearHistory, onRenameSession, onEnableDiary, onPauseDiary, onDeleteAllDiary,
}: SessionsTabProps) {
  const [channels, setChannels] = useState<TelegramChannel[]>([]);
  const [links, setLinks] = useState<Record<string, SessionTelegramLink>>({});

  useEffect(() => {
    setChannels(loadChannels());
    const initial: Record<string, SessionTelegramLink> = {};
    for (const s of sessions) initial[s.id] = loadSessionLink(s.id);
    setLinks(initial);
    function onFocus() { setChannels(loadChannels()); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.map((s) => s.id).join(",")]);

  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <BookMarked className="h-8 w-8 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">Nenhuma configuração salva ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Vá até a aba <strong>Padrões</strong>, configure o motor e clique em <strong>&quot;Salvar configuração&quot;</strong>.
          </p>
        </CardContent>
      </Card>
    );
  }

  const collectingCount = collectingIds.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <BookMarked className="h-4 w-4 text-primary" />
            Configurações salvas
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Marque várias sessões como <strong>Coletando</strong> para acumular históricos ao vivo em paralelo
            {collectingCount > 0 && <> · <span className="text-primary">{collectingCount} coletando agora</span></>}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessions.map(session => (
            <SessionCard
              key={session.id} session={session}
              isCollecting={collectingIds.includes(session.id)}
              liveHistory={sessionHistories[session.id]}
              channels={channels}
              telegramLink={links[session.id] ?? { enabled: false, channelId: null }}
              onTelegramChange={(link) => setLinks((prev) => ({ ...prev, [session.id]: link }))}
              onChannelsChange={() => setChannels(loadChannels())}
              onToggleCollecting={() => onToggleCollecting(session.id)}
              onDelete={() => onDelete(session.id)}
              onClearHistory={() => onClearHistory(session.id)}
              onRename={(name) => onRenameSession(session.id, name)}
              onEnableDiary={() => onEnableDiary(session.id)}
              onPauseDiary={() => onPauseDiary(session.id)}
              onDeleteAllDiary={onDeleteAllDiary}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
