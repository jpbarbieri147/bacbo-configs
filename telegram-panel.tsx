"use client";

// components/bacbo/telegram-panel.tsx

import { useState, useEffect } from "react";
import {
  Send, CheckCircle2, AlertCircle,
  Loader2, Bot, Plus, Trash2, Eye, EyeOff, BookOpen,
  ChevronDown, ChevronUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { MonitorStatus } from "@/lib/useTelegramMonitor";
import type { PatternInsight, PatternSettings } from "@/lib/bacboAnalytics";
import {
  loadChannels,
  saveChannels,
  testChannel,
  makeChannelId,
  type TelegramChannel,
} from "@/lib/telegramService";

interface TelegramPanelProps {
  enabled?: boolean;
  status?: MonitorStatus;
  onToggle?: () => void;
  currentAlert?: PatternInsight | undefined;
  patterns?: PatternInsight[];
  settings?: PatternSettings;
}

// ─── URL base da API ──────────────────────────────────────────────────────────
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://187.127.38.39:5000";

// ─── Sincroniza lista de canais com o banco da VPS ───────────────────────────
async function syncCanaisComBanco(canais: TelegramChannel[]): Promise<void> {
  try {
    await fetch(`${API_BASE}/sessoes/canais`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canais }),
    });
  } catch (err) {
    // Não bloqueia o usuário se a VPS estiver temporariamente inacessível
    console.warn("[TelegramPanel] Falha ao sincronizar canais com o banco:", err);
  }
}

// ─── Instruções de configuração ───────────────────────────────────────────────

function SetupGuide({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/[0.04]">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-primary">Como configurar seu bot</span>
        </div>
        {open
          ? <ChevronUp className="h-4 w-4 text-primary" />
          : <ChevronDown className="h-4 w-4 text-primary" />}
      </button>
      {open && (
        <div className="border-t border-primary/10 px-4 pb-4 pt-3 space-y-2 text-xs text-primary/80">
          <p><strong>Passo 1 —</strong> No Telegram, procure por <code>@BotFather</code> e envie <code>/newbot</code></p>
          <p><strong>Passo 2 —</strong> Escolha um nome e um username para o bot (ex: <code>MeuBacBoBot</code>)</p>
          <p><strong>Passo 3 —</strong> Copie o token gerado (formato: <code>123456:ABC-DEF...</code>) e cole abaixo</p>
          <p><strong>Passo 4 —</strong> Para receber no chat pessoal: procure <code>@userinfobot</code> e envie qualquer mensagem — ele retorna seu Chat ID</p>
          <p><strong>Passo 5 —</strong> Para enviar a um canal: adicione o bot como administrador e use o username do canal (ex: <code>@meucanal</code>) ou o ID numérico</p>
          <p><strong>Passo 6 —</strong> Cole o token e os destinos abaixo, clique em Salvar e teste</p>
        </div>
      )}
    </div>
  );
}

// ─── Gerenciador de canais ────────────────────────────────────────────────────

function ChannelEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  isNew,
}: {
  draft: TelegramChannel;
  onChange: (c: TelegramChannel) => void;
  onSave: () => void;
  onCancel: () => void;
  isNew: boolean;
}) {
  const [showToken, setShowToken] = useState(false);
  const valid = draft.name.trim() && draft.token.trim() && draft.chatId.trim();

  return (
    <div className="rounded-xl border border-white/[0.1] bg-white/[0.03] p-3 space-y-2.5">
      <input
        type="text"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder="Nome do canal (ex: Canal VIP)"
        className="w-full h-9 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-foreground outline-none focus:border-primary/50"
      />
      <div className="flex gap-2">
        <input
          type={showToken ? "text" : "password"}
          value={draft.token}
          onChange={(e) => onChange({ ...draft, token: e.target.value })}
          placeholder="Token do bot (123456:ABC-DEF...)"
          className="flex-1 h-9 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-foreground outline-none focus:border-primary/50 font-mono"
        />
        <Button size="sm" variant="ghost" onClick={() => setShowToken((s) => !s)} className="px-2">
          {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>
      <input
        type="text"
        value={draft.chatId}
        onChange={(e) => onChange({ ...draft, chatId: e.target.value })}
        placeholder="Chat ID ou @canal (-1001234567890 ou @meucanal)"
        className="w-full h-9 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-foreground outline-none focus:border-primary/50 font-mono"
      />
      <div className="flex gap-2 pt-0.5">
        <Button size="sm" onClick={onSave} disabled={!valid} className="flex-1">
          {isNew ? "Adicionar canal" : "Salvar"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function ChannelsManager({ onChange }: { onChange?: () => void }) {
  const [channels, setChannels] = useState<TelegramChannel[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TelegramChannel | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    setChannels(loadChannels());
  }, []);

  // ── PATCH: persist agora sincroniza com o banco além do localStorage ────────
  function persist(next: TelegramChannel[]) {
    setChannels(next);
    saveChannels(next);          // localStorage (comportamento original)
    syncCanaisComBanco(next);    // ← NOVO: espelha no banco da VPS
    onChange?.();
  }
  // ───────────────────────────────────────────────────────────────────────────

  function startNew() {
    setDraft({ id: makeChannelId(), name: "", token: "", chatId: "", status: "untested" });
    setEditingId("__new__");
  }

  function startEdit(c: TelegramChannel) {
    setDraft({ ...c });
    setEditingId(c.id);
  }

  function saveDraft() {
    if (!draft) return;
    const exists = channels.some((c) => c.id === draft.id);
    const next = exists
      ? channels.map((c) => (c.id === draft.id ? { ...draft, status: "untested" as const } : c))
      : [...channels, { ...draft, status: "untested" as const }];
    persist(next);
    setDraft(null);
    setEditingId(null);
  }

  function remove(id: string) {
    persist(channels.filter((c) => c.id !== id));
  }

  async function runTest(c: TelegramChannel) {
    setTestingId(c.id);
    const ok = await testChannel(c);
    const next = channels.map((x) =>
      x.id === c.id ? { ...x, status: (ok ? "ok" : "error") as TelegramChannel["status"] } : x,
    );
    persist(next);
    setTestingId(null);
  }

  return (
    <div className="space-y-2.5">
      {channels.length === 0 && editingId !== "__new__" && (
        <p className="text-xs text-muted-foreground py-1">
          Nenhum canal ainda. Crie um canal para vincular às suas sessões.
        </p>
      )}

      {channels.map((c) =>
        editingId === c.id ? (
          <ChannelEditor
            key={c.id}
            draft={draft!}
            onChange={setDraft}
            onSave={saveDraft}
            onCancel={() => { setDraft(null); setEditingId(null); }}
            isNew={false}
          />
        ) : (
          <div
            key={c.id}
            className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${
                  c.status === "ok" ? "bg-emerald-400"
                  : c.status === "error" ? "bg-destructive"
                  : "bg-muted-foreground/40"
                }`}
                title={c.status === "ok" ? "Conectado" : c.status === "error" ? "Erro" : "Não testado"}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                <p className="text-[11px] text-muted-foreground font-mono truncate">{c.chatId}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm" variant="ghost"
                onClick={() => runTest(c)}
                disabled={testingId === c.id}
                className="h-7 px-2 text-xs"
                title="Testar conexão"
              >
                {testingId === c.id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : c.status === "ok"
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    : c.status === "error"
                      ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                      : <Send className="h-3.5 w-3.5" />}
              </Button>
              <button
                onClick={() => startEdit(c)}
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Editar
              </button>
              <button
                onClick={() => remove(c.id)}
                className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                title="Remover canal"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ),
      )}

      {editingId === "__new__" && draft ? (
        <ChannelEditor
          draft={draft}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={() => { setDraft(null); setEditingId(null); }}
          isNew
        />
      ) : (
        <Button size="sm" onClick={startNew} className="w-full">
          <Plus className="h-4 w-4 mr-1" /> Adicionar canal
        </Button>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function TelegramPanel(_props: TelegramPanelProps) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(true);
  const [hasChannels, setHasChannels] = useState(false);

  useEffect(() => {
    const chans = loadChannels();
    setHasChannels(chans.length > 0);
    setConfigOpen(chans.length === 0);
  }, []);

  return (
    <div className="space-y-4 max-w-xl mx-auto">

      {/* Card principal */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-base">Monitor Telegram</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Gerencie os canais que recebem os sinais ao vivo das sessões
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">

          {/* Guia de configuração */}
          <SetupGuide open={guideOpen} onToggle={() => setGuideOpen(o => !o)} />

          {/* Gerenciador de canais */}
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02]">
            <button
              onClick={() => setConfigOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-left"
            >
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Canais do Telegram</span>
                {hasChannels && (
                  <Badge className="text-xs border-primary/30 text-primary">
                    Configurado
                  </Badge>
                )}
              </div>
              {configOpen
                ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
            {configOpen && (
              <div className="border-t border-white/[0.06] px-4 pb-4 pt-3 space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  Crie um ou mais canais. Depois, em <strong className="text-foreground">Sessões</strong>,
                  clique no botão <Send className="inline h-3 w-3 mb-0.5" /> de cada sessão coletando
                  para escolher para qual canal ela envia os sinais ao vivo.
                </p>
                <ChannelsManager onChange={() => setHasChannels(loadChannels().length > 0)} />
              </div>
            )}
          </div>

          {/* Como funciona */}
          <div className="rounded-2xl border border-primary/15 bg-primary/[0.04] p-3 text-xs text-muted-foreground space-y-1.5">
            <p className="font-medium text-primary">Como os sinais são enviados</p>
            <p>
              O envio acontece por <strong className="text-foreground">sessão</strong>. Cada sessão
              que estiver <strong className="text-foreground">Coletando</strong> pode despachar seus
              sinais ao vivo para um canal escolhido aqui — o sinal sai no momento em que o padrão se
              forma, e o resultado é enviado em seguida.
            </p>
          </div>

        </CardContent>
      </Card>

    </div>
  );
}
