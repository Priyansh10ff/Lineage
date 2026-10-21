import type { Doc, Meta, Unit } from '@lineage/core';
import type { Language as TSLanguage, Node as TSNode, Parser as TSParser } from '@vscode/tree-sitter-wasm';
import type { CodeParser } from './types.js';
import { extname } from './util.js';

/** Extension → grammar file (in @vscode/tree-sitter-wasm) and display name. */
export const LANGUAGES: Record<string, { grammar: string; name: string }> = {
  '.ts': { grammar: 'typescript', name: 'typescript' },
  '.mts': { grammar: 'typescript', name: 'typescript' },
  '.cts': { grammar: 'typescript', name: 'typescript' },
  '.tsx': { grammar: 'tsx', name: 'tsx' },
  '.js': { grammar: 'javascript', name: 'javascript' },
  '.mjs': { grammar: 'javascript', name: 'javascript' },
  '.cjs': { grammar: 'javascript', name: 'javascript' },
  '.jsx': { grammar: 'javascript', name: 'javascript' },
  '.py': { grammar: 'python', name: 'python' },
  '.go': { grammar: 'go', name: 'go' },
  '.rs': { grammar: 'rust', name: 'rust' },
  '.java': { grammar: 'java', name: 'java' },
  '.cs': { grammar: 'c-sharp', name: 'csharp' },
  '.c': { grammar: 'cpp', name: 'c' },
  '.h': { grammar: 'cpp', name: 'c' },
  '.cc': { grammar: 'cpp', name: 'cpp' },
  '.cpp': { grammar: 'cpp', name: 'cpp' },
  '.hpp': { grammar: 'cpp', name: 'cpp' },
  '.rb': { grammar: 'ruby', name: 'ruby' },
  '.php': { grammar: 'php', name: 'php' },
  '.sh': { grammar: 'bash', name: 'bash' },
  '.bash': { grammar: 'bash', name: 'bash' },
  '.css': { grammar: 'css', name: 'css' },
};

/** Source-ish files without a bundled grammar: versioned as code, chunked by blank-line blocks. */
export const PLAIN_CODE_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sql', '.html', '.htm', '.xml', '.scss', '.less',
  '.vue', '.svelte', '.kt', '.swift', '.scala', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.hs',
  '.ml', '.zig', '.ps1', '.dockerfile', '.tf', '.graphql', '.proto', '.ipynb', '.env.example',
]);

export function languageOf(path: string): string {
  const ext = extname(path);
  return LANGUAGES[ext]?.name ?? (ext ? ext.slice(1) : 'text');
}

export function isCodePath(path: string): boolean {
  const ext = extname(path);
  const base = path.split('/').pop() ?? '';
  return ext in LANGUAGES || PLAIN_CODE_EXTENSIONS.has(ext) || /^(Dockerfile|Makefile|Procfile)$/.test(base);
}

function codeDoc(path: string, units: Unit[], extra: Meta = {}): Doc {
  return { kind: 'code', title: path, meta: { language: languageOf(path), path, ...extra }, units };
}

/**
 * Fallback for languages without a grammar: blocks separated by blank lines, up to ~40 lines each.
 * Units are contiguous slices, so concatenating their text reproduces the file exactly.
 */
export function chunkByBlocks(path: string, source: string, maxLines = 40): Doc {
  const lines = source.split(/(?<=\n)/);
  const units: Unit[] = [];
  let buf: string[] = [];
  let content = 0;
  const flush = () => {
    if (buf.length) units.push({ type: 'line', text: buf.join('') });
    buf = [];
    content = 0;
  };
  for (const line of lines) {
    const blank = !line.trim();
    // Start a new block at the first non-blank line after a blank one.
    if (!blank && buf.length && (!buf[buf.length - 1]!.trim() || content >= maxLines)) flush();
    buf.push(line);
    if (!blank) content++;
  }
  flush();
  return codeDoc(path, units, { parser: 'blocks' });
}

// ---------------------------------------------------------------- tree-sitter

type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'impl'
  | 'module'
  | 'variable'
  | 'import'
  | 'statement'
  | 'comment';

/** Unwrap `export …`, decorators and similar wrappers to the declaration they carry. */
function unwrap(node: TSNode): TSNode {
  if (node.type === 'export_statement') {
    return node.childForFieldName('declaration') ?? node.childForFieldName('value') ?? node;
  }
  if (node.type === 'decorated_definition') return node.childForFieldName('definition') ?? node;
  if (node.type === 'template_declaration') return node.namedChildren.filter((n): n is TSNode => !!n).at(-1) ?? node;
  return node;
}

function kindOf(node: TSNode, inClass: boolean): SymbolKind {
  const t = node.type;
  if (t === 'comment' || t === 'line_comment' || t === 'block_comment') return 'comment';
  if (/import|^use_declaration$|^using_directive$|^preproc_include$|^package_clause$|^require/.test(t)) return 'import';
  if (/^(method_definition|method_declaration|method|singleton_method|constructor_declaration)$/.test(t)) return 'method';
  if (/function|^function_item$|^arrow_function$/.test(t)) return inClass ? 'method' : 'function';
  if (/^(class_declaration|class_definition|class|abstract_class_declaration|class_specifier|record_declaration)$/.test(t))
    return 'class';
  if (/^(interface_declaration|trait_item|protocol_declaration)$/.test(t)) return 'interface';
  if (/^(type_alias_declaration|type_item|type_declaration|type_definition|alias_declaration)$/.test(t)) return 'type';
  if (/^(enum_declaration|enum_item|enum_specifier)$/.test(t)) return 'enum';
  if (/^(struct_item|struct_specifier|struct_declaration)$/.test(t)) return 'struct';
  if (/^(impl_item)$/.test(t)) return 'impl';
  if (/^(module|mod_item|namespace_definition|namespace_declaration|internal_module)$/.test(t)) return 'module';
  if (/^(lexical_declaration|variable_declaration)$/.test(t)) {
    const decl = node.namedChildren.find((n) => n?.type === 'variable_declarator');
    const value = decl?.childForFieldName('value');
    return value && /function|arrow_function|class/.test(value.type) ? 'function' : 'variable';
  }
  if (/^(public_field_definition|field_definition|field_declaration|property_declaration)$/.test(t) && inClass) return 'variable';
  return 'statement';
}

function nameOf(node: TSNode): string | undefined {
  const direct = node.childForFieldName('name');
  if (direct) return direct.text;
  if (node.type === 'impl_item') {
    const trait = node.childForFieldName('trait')?.text;
    const type = node.childForFieldName('type')?.text;
    return trait && type ? `${trait} for ${type}` : type;
  }
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'variable_declarator' || child.type === 'type_spec' || child.type === 'const_spec') {
      return child.childForFieldName('name')?.text;
    }
    if (child.type === 'function_declarator' || child.type === 'declarator') return nameOf(child) ?? child.text;
  }
  const declarator = node.childForFieldName('declarator');
  if (declarator) return nameOf(declarator) ?? declarator.text.split('(')[0];
  return undefined;
}

const CONTAINERS: SymbolKind[] = ['class', 'interface', 'struct', 'impl', 'module', 'enum'];

interface Piece {
  /** Exclusive end offset of this piece in the source. Pieces are contiguous. */
  end: number;
  kind: SymbolKind;
  name?: string;
}

/** Split a container's body into header / member / … pieces so methods diff individually. */
function containerPieces(node: TSNode, decl: TSNode, kind: SymbolKind, name: string | undefined, source: string): Piece[] | null {
  const body = decl.childForFieldName('body') ?? decl.namedChildren.find((n) => n?.type.endsWith('body') || n?.type === 'block');
  const members = body?.namedChildren.filter((n): n is TSNode => !!n) ?? [];
  const lines = source.slice(node.startIndex, node.endIndex).split('\n').length;
  if (!body || members.length < 2 || lines < 12) return null;

  const pieces: Piece[] = [];
  // Header: everything up to the line the first member starts on.
  const firstStart = source.lastIndexOf('\n', members[0]!.startIndex - 1) + 1;
  if (firstStart <= node.startIndex) return null;
  pieces.push({ end: firstStart, kind, ...(name ? { name } : {}) });

  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    const inner = unwrap(m);
    const mk = kindOf(inner, true);
    // Comments attach to the next member: pieces are contiguous, so skipping one folds it forward.
    if (mk === 'comment' && i < members.length - 1) continue;
    const memberName = nameOf(inner);
    const isLast = i === members.length - 1;
    // Each member's piece ends at the end of its line, so the next member starts on a fresh line.
    const lineEnd = source.indexOf('\n', m.endIndex);
    const end = isLast ? node.endIndex : lineEnd === -1 || lineEnd >= node.endIndex ? m.endIndex : lineEnd + 1;
    pieces.push({
      end,
      kind: mk === 'statement' ? 'variable' : mk,
      ...(memberName ? { name: name ? `${name}.${memberName}` : memberName } : {}),
    });
  }
  return pieces;
}

/**
 * Turn a syntax tree into symbol units. Top-level declarations become units, large containers
 * (classes, impls, …) are split per member, consecutive imports and loose statements are grouped,
 * and comments attach to the declaration that follows. Units are contiguous slices of the file,
 * so `units.map(u => u.text).join('')` reproduces it byte for byte.
 */
export function symbolsToUnits(root: TSNode, source: string): Unit[] {
  const pieces: Piece[] = [];
  const nodes = root.namedChildren.filter((n): n is TSNode => !!n);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const decl = unwrap(node);
    const kind = kindOf(decl, false);
    if (kind === 'comment' && i < nodes.length - 1) continue; // leading comment of the next node
    const name = nameOf(decl);

    if (CONTAINERS.includes(kind)) {
      const split = containerPieces(node, decl, kind, name, source);
      if (split) {
        pieces.push(...split);
        continue;
      }
    }

    const prev = pieces[pieces.length - 1];
    // Group consecutive imports, and consecutive loose statements (up to ~30 lines).
    if (prev && prev.kind === kind && (kind === 'import' || kind === 'statement')) {
      const start = pieces.length > 1 ? pieces[pieces.length - 2]!.end : 0;
      const size = source.slice(start, node.endIndex).split('\n').length;
      if (kind === 'import' || size <= 30) {
        prev.end = node.endIndex;
        continue;
      }
    }
    pieces.push({ end: node.endIndex, kind, ...(name ? { name } : {}) });
  }

  const units: Unit[] = [];
  let start = 0;
  for (const p of pieces) {
    if (p.end <= start) continue;
    const text = source.slice(start, p.end);
    start = p.end;
    if (p.kind === 'statement' || p.kind === 'comment') {
      units.push({ type: 'line', text });
    } else {
      const meta: Meta = { symbolKind: p.kind === 'import' ? 'imports' : p.kind };
      if (p.kind === 'import') meta['name'] = 'imports';
      else if (p.name) meta['name'] = p.name;
      units.push({ type: 'symbol', text, meta });
    }
  }
  // Trailing whitespace/comments after the last node.
  if (start < source.length) {
    const tail = source.slice(start);
    const last = units[units.length - 1];
    if (last) last.text += tail;
    else units.push({ type: 'line', text: tail });
  }
  // Blank lines between declarations belong to the end of the previous unit, so each unit's
  // text starts at its own first line. Concatenation still reproduces the file exactly.
  for (let i = 1; i < units.length; i++) {
    const lead = /^(?:[ \t]*\r?\n)+/.exec(units[i]!.text)?.[0];
    if (lead) {
      units[i - 1]!.text += lead;
      units[i]!.text = units[i]!.text.slice(lead.length);
    }
  }
  return units.filter((u) => u.text.length > 0);
}

export interface TreeSitterModule {
  Parser: typeof TSParser;
  Language: typeof TSLanguage;
}

/**
 * Code parser backed by tree-sitter. `loadGrammar` returns the wasm bytes for a grammar name
 * (e.g. `typescript`), so this works in Node (read from disk) and the browser (fetch).
 */
export function createTreeSitterParser(
  ts: TreeSitterModule,
  loadGrammar: (grammar: string) => Promise<Uint8Array>,
): CodeParser {
  let ready: Promise<void> | null = null;
  const languages = new Map<string, Promise<TSLanguage>>();
  const language = (grammar: string) => {
    let l = languages.get(grammar);
    if (!l) {
      l = loadGrammar(grammar).then((bytes) => ts.Language.load(bytes));
      languages.set(grammar, l);
    }
    return l;
  };

  return {
    async parse(path, source) {
      const spec = LANGUAGES[extname(path)];
      if (!spec) return null;
      ready ??= ts.Parser.init();
      await ready;
      const parser = new ts.Parser();
      try {
        parser.setLanguage(await language(spec.grammar));
        const tree = parser.parse(source);
        if (!tree) return null;
        try {
          const units = symbolsToUnits(tree.rootNode, source);
          const meta: Meta = { parser: 'tree-sitter' };
          if (tree.rootNode.hasError) meta['parseErrors'] = true;
          return codeDoc(path, units, meta);
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    },
  };
}

export async function parseCode(path: string, source: string, parser?: CodeParser): Promise<Doc> {
  return (parser && (await parser.parse(path, source))) || chunkByBlocks(path, source);
}
