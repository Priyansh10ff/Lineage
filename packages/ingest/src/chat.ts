import type { Doc, Meta, Unit } from '@lineage/core';
import { isRecord, slugify, toIso } from './util.js';

export interface ParsedChat {
  id: string;
  doc: Doc;
}

type Role = 'user' | 'assistant' | 'system' | 'tool';

function turn(role: Role, text: string, extra: Record<string, Meta[string] | undefined> = {}): Unit {
  const meta: Meta = { role };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) meta[k] = v;
  return { type: 'turn', text: text.trim(), meta };
}

function chatDoc(title: string | undefined, units: Unit[], meta: Meta): Doc {
  const doc: Doc = { kind: 'chat', units, meta };
  if (title) doc.title = title;
  return doc;
}

// ---------------------------------------------------------------- ChatGPT

/** Text of one ChatGPT message, or `null` for content that isn't part of the visible conversation. */
function chatgptText(content: Record<string, unknown>): string | null {
  const type = content['content_type'];
  const parts = Array.isArray(content['parts']) ? content['parts'] : [];
  switch (type) {
    case 'text':
      return parts.filter((p): p is string => typeof p === 'string').join('\n');
    case 'multimodal_text':
      return parts
        .map((p) => {
          if (typeof p === 'string') return p;
          if (!isRecord(p)) return '';
          if (p['content_type'] === 'image_asset_pointer') return '[image]';
          if (p['content_type'] === 'audio_transcription' && typeof p['text'] === 'string') return p['text'];
          return '';
        })
        .filter(Boolean)
        .join('\n');
    case 'code': {
      const text = typeof content['text'] === 'string' ? content['text'] : '';
      const lang = typeof content['language'] === 'string' && content['language'] !== 'unknown' ? content['language'] : '';
      return text ? `\`\`\`${lang}\n${text}\n\`\`\`` : '';
    }
    case 'execution_output':
      return typeof content['text'] === 'string' ? content['text'] : '';
    case 'tether_quote': {
      const title = typeof content['title'] === 'string' ? content['title'] : '';
      const text = typeof content['text'] === 'string' ? content['text'] : '';
      return `> ${text.replace(/\n/g, '\n> ')}${title ? `\n> (${title})` : ''}`;
    }
    default:
      // thoughts, reasoning_recap, user_editable_context, tether_browsing_display, system_error, …
      return null;
  }
}

/**
 * Parse one ChatGPT conversation from `conversations.json`. Messages form a tree (edits and
 * regenerations create siblings), so the visible thread is rebuilt by walking from
 * `current_node` up through parents. Turns with hidden siblings get `meta.alternates`.
 */
export function parseChatGPTConversation(conv: Record<string, unknown>): ParsedChat | null {
  const mapping = conv['mapping'];
  if (!isRecord(mapping)) return null;
  const nodes = mapping as Record<string, Record<string, unknown>>;

  let current = typeof conv['current_node'] === 'string' ? conv['current_node'] : undefined;
  if (!current || !nodes[current]) {
    // Fallback: follow the last child from the root.
    let root = Object.values(nodes).find((n) => !n['parent']);
    while (root && Array.isArray(root['children']) && root['children'].length) {
      const next = nodes[root['children'][root['children'].length - 1] as string];
      if (!next) break;
      root = next;
    }
    current = root?.['id'] as string | undefined;
  }

  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (current && nodes[current] && !seen.has(current)) {
    seen.add(current);
    path.push(nodes[current]!);
    current = nodes[current]!['parent'] as string | undefined;
  }
  path.reverse();

  const units: Unit[] = [];
  const models = new Set<string>();
  for (const node of path) {
    const msg = node['message'];
    if (!isRecord(msg)) continue;
    const author = isRecord(msg['author']) ? msg['author'] : {};
    const role = author['role'];
    const metadata = isRecord(msg['metadata']) ? msg['metadata'] : {};
    if (role === 'system' || metadata['is_visually_hidden_from_conversation']) continue;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const content = isRecord(msg['content']) ? msg['content'] : {};
    const text = chatgptText(content);
    if (!text?.trim()) continue;

    const parent = node['parent'] ? nodes[node['parent'] as string] : undefined;
    const siblings = Array.isArray(parent?.['children']) ? parent['children'].length : 1;
    const model = typeof metadata['model_slug'] === 'string' ? metadata['model_slug'] : undefined;
    if (model && role === 'assistant') models.add(model);
    units.push(
      turn(role, text, {
        timestamp: toIso(msg['create_time']),
        model: role === 'assistant' ? model : undefined,
        alternates: siblings > 1 ? siblings - 1 : undefined,
        tool: role === 'tool' && typeof author['name'] === 'string' ? author['name'] : undefined,
      }),
    );
  }

  const id = String(conv['conversation_id'] ?? conv['id'] ?? '');
  const title = typeof conv['title'] === 'string' ? conv['title'] : undefined;
  const meta: Meta = { source: 'chatgpt' };
  if (id) meta['conversationId'] = id;
  const created = toIso(conv['create_time']);
  if (created) meta['createdAt'] = created;
  if (models.size) meta['models'] = [...models].join(', ');
  return { id: id || slugify(title ?? 'chat'), doc: chatDoc(title, units, meta) };
}

// ---------------------------------------------------------------- Claude

function claudeText(msg: Record<string, unknown>): string {
  const blocks = Array.isArray(msg['content']) ? msg['content'] : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (!isRecord(b)) continue;
    if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
    else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') parts.push(`[tool: ${b['name']}]`);
    // thinking, tool_result, … are not part of the visible conversation
  }
  const text = parts.join('\n\n').trim();
  return text || (typeof msg['text'] === 'string' ? msg['text'] : '');
}

/** Parse one conversation from a Claude data export (`conversations.json`). */
export function parseClaudeConversation(conv: Record<string, unknown>): ParsedChat | null {
  const messages = conv['chat_messages'];
  if (!Array.isArray(messages)) return null;
  const units: Unit[] = [];
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const sender = m['sender'];
    const role: Role | null = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const files = [
      ...(Array.isArray(m['attachments']) ? m['attachments'] : []),
      ...(Array.isArray(m['files']) ? m['files'] : []),
    ]
      .map((f) => (isRecord(f) && typeof f['file_name'] === 'string' ? f['file_name'] : null))
      .filter((f): f is string => !!f);
    let text = claudeText(m);
    if (files.length) text = `${text}\n\n${files.map((f) => `[attachment: ${f}]`).join('\n')}`;
    if (!text.trim()) continue;
    units.push(turn(role, text, { timestamp: toIso(m['created_at']), attachments: files.length ? files.join(', ') : undefined }));
  }
  const id = String(conv['uuid'] ?? '');
  const title = typeof conv['name'] === 'string' && conv['name'] ? conv['name'] : undefined;
  const meta: Meta = { source: 'claude' };
  if (id) meta['conversationId'] = id;
  const created = toIso(conv['created_at']);
  if (created) meta['createdAt'] = created;
  return { id: id || slugify(title ?? 'chat'), doc: chatDoc(title, units, meta) };
}

// ---------------------------------------------------------------- detection

export type ChatExportFormat = 'chatgpt' | 'claude';

/** Recognize a ChatGPT or Claude export by shape; their schemas differ, so each gets its own parser. */
export function detectChatExport(json: unknown): ChatExportFormat | null {
  const first = Array.isArray(json) ? json.find(isRecord) : json;
  if (!isRecord(first)) return null;
  if (isRecord(first['mapping'])) return 'chatgpt';
  if (Array.isArray(first['chat_messages'])) return 'claude';
  return null;
}

export function parseChatExport(json: unknown): { format: ChatExportFormat; chats: ParsedChat[] } | null {
  const format = detectChatExport(json);
  if (!format) return null;
  const list = (Array.isArray(json) ? json : [json]).filter(isRecord);
  const parse = format === 'chatgpt' ? parseChatGPTConversation : parseClaudeConversation;
  const chats = list.map(parse).filter((c): c is ParsedChat => !!c && c.doc.units.length > 0);
  return { format, chats };
}

// ---------------------------------------------------------------- Markdown transcripts

const ROLE_WORDS: Record<string, Role> = {
  user: 'user',
  you: 'user',
  human: 'user',
  me: 'user',
  assistant: 'assistant',
  chatgpt: 'assistant',
  claude: 'assistant',
  ai: 'assistant',
  gpt: 'assistant',
  model: 'assistant',
  system: 'system',
};

/** `## User`, `**Assistant:**`, `Human: …`, `### ChatGPT said:` and similar. Group 2 is any text on the same line. */
const MARKER =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(user|you|human|me|assistant|chatgpt|claude|ai|gpt|model|system)(?:\s+said)?\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i;

function matchMarker(line: string): { role: Role; rest: string } | null {
  const m = MARKER.exec(line.trim());
  if (!m) return null;
  const isHeading = /^#{1,6}\s/.test(line.trim());
  const isBold = /^(\*\*|__)/.test(line.trim());
  const hasColon = /:/.test(line);
  // A bare word like "Model" at the start of a sentence is not a marker; require heading, bold or colon.
  if (!isHeading && !isBold && !hasColon) return null;
  return { role: ROLE_WORDS[m[1]!.toLowerCase()]!, rest: m[2] ?? '' };
}

/** Treat Markdown as a chat transcript only if it has markers for both a user and an assistant. */
export function looksLikeChatMarkdown(text: string): boolean {
  const roles = new Set<Role>();
  let markers = 0;
  for (const line of text.split('\n')) {
    const m = matchMarker(line);
    if (m) {
      roles.add(m.role);
      markers++;
    }
  }
  return markers >= 2 && roles.has('user') && roles.has('assistant');
}

export function parseChatMarkdown(text: string, fallbackTitle?: string): Doc {
  const units: Unit[] = [];
  let title: string | undefined;
  let role: Role | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (role && buf.join('\n').trim()) units.push(turn(role, buf.join('\n')));
    buf = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = matchMarker(line);
    if (m) {
      flush();
      role = m.role;
      if (m.rest.trim()) buf.push(m.rest);
      continue;
    }
    if (!role) {
      const h = /^#\s+(.+)$/.exec(line.trim());
      if (h && !title) title = h[1]!.trim();
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) continue; // turn separators
    buf.push(line);
  }
  flush();
  return chatDoc(title ?? fallbackTitle, units, { source: 'markdown' });
}
