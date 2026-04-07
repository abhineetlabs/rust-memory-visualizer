/**
 * Rust Memory Analyzer
 *
 * Tokenizes Rust source code and classifies each declaration
 * into memory segments: stack, heap, .rodata, .data, .bss, .text
 *
 * This is a heuristic analyzer — it does NOT compile the code.
 * It uses pattern matching on the token stream to determine
 * where data lives at runtime.
 */

const RustAnalyzer = (() => {

  // ==========================================
  // Token Types
  // ==========================================

  const TT = {
    Keyword: 'keyword',
    Ident: 'ident',
    Number: 'number',
    String: 'string',
    Char: 'char',
    ByteString: 'bytestring',
    RawString: 'rawstring',
    Lifetime: 'lifetime',
    Symbol: 'symbol',
    Attribute: 'attribute',
    Comment: 'comment',
    Whitespace: 'ws',
    EOF: 'eof',
  };

  const KEYWORDS = new Set([
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
    'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
    'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
    'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type',
    'union', 'unsafe', 'use', 'where', 'while', 'yield', 'box',
  ]);

  // Types that allocate on the heap
  const HEAP_TYPES = new Set([
    'Box', 'Vec', 'String', 'HashMap', 'BTreeMap', 'HashSet', 'BTreeSet',
    'LinkedList', 'VecDeque', 'BinaryHeap', 'Rc', 'Arc',
    'Mutex', 'RwLock', 'PathBuf', 'OsString', 'CString',
  ]);

  // Types that use interior mutability but stay on the stack
  const INTERIOR_MUT_TYPES = new Set(['RefCell', 'Cell']);

  // Types that are always stack-allocated (primitive or small)
  const STACK_PRIMITIVES = new Set([
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'f32', 'f64', 'bool', 'char',
  ]);

  // Size estimates in bytes for common types
  const TYPE_SIZES = {
    'i8': 1, 'u8': 1, 'bool': 1,
    'i16': 2, 'u16': 2,
    'i32': 4, 'u32': 4, 'f32': 4,
    'i64': 8, 'u64': 8, 'f64': 8,
    'i128': 16, 'u128': 16,
    'isize': 8, 'usize': 8,
    'char': 4,
    'Box': 8,        // pointer
    'Vec': 24,       // ptr + len + cap
    'String': 24,    // ptr + len + cap
    'HashMap': 48,   // approximate
    'BTreeMap': 24,  // approximate
    'HashSet': 48,
    'BTreeSet': 24,
    'Rc': 8,         // pointer
    'Arc': 8,        // pointer
    'Option': null,   // depends on inner
    'Result': null,
    'Mutex': 8,
    'RwLock': 8,
    'RefCell': null,
    'Cell': null,
    'PathBuf': 24,
    'OsString': 24,
    'CString': 24,
    'VecDeque': 32,
    'LinkedList': 16,
    'BinaryHeap': 24,
    'Cow': 24,
    'Pin': null,
  };

  // Macros that produce heap allocations
  const HEAP_MACROS = new Set([
    'vec', 'format', 'string', 'to_string',
  ]);

  // Macros that produce string/rodata references
  const RODATA_MACROS = new Set([
    'concat', 'stringify', 'include_str', 'include_bytes',
    'env', 'option_env', 'file', 'line', 'column', 'module_path',
  ]);

  // ==========================================
  // Tokenizer
  // ==========================================

  function tokenize(source) {
    const tokens = [];
    let pos = 0;
    const len = source.length;

    while (pos < len) {
      const start = pos;
      const ch = source[pos];

      // Whitespace
      if (/\s/.test(ch)) {
        while (pos < len && /\s/.test(source[pos])) pos++;
        tokens.push({ type: TT.Whitespace, value: source.slice(start, pos), start, end: pos });
        continue;
      }

      // Line comment
      if (ch === '/' && source[pos + 1] === '/') {
        while (pos < len && source[pos] !== '\n') pos++;
        tokens.push({ type: TT.Comment, value: source.slice(start, pos), start, end: pos });
        continue;
      }

      // Block comment (handles nesting)
      if (ch === '/' && source[pos + 1] === '*') {
        let depth = 1;
        pos += 2;
        while (pos < len && depth > 0) {
          if (source[pos] === '/' && source[pos + 1] === '*') {
            depth++;
            pos += 2;
          } else if (source[pos] === '*' && source[pos + 1] === '/') {
            depth--;
            pos += 2;
          } else {
            pos++;
          }
        }
        tokens.push({ type: TT.Comment, value: source.slice(start, pos), start, end: pos });
        continue;
      }

      // Attribute
      if (ch === '#' && (source[pos + 1] === '[' || (source[pos + 1] === '!' && source[pos + 2] === '['))) {
        const attrStart = pos;
        pos += (source[pos + 1] === '!') ? 3 : 2;
        let bracketDepth = 1;
        while (pos < len && bracketDepth > 0) {
          if (source[pos] === '[') bracketDepth++;
          else if (source[pos] === ']') bracketDepth--;
          pos++;
        }
        tokens.push({ type: TT.Attribute, value: source.slice(attrStart, pos), start: attrStart, end: pos });
        continue;
      }

      // Raw string: r#"..."# or r"..."
      if (ch === 'r' && (source[pos + 1] === '#' || source[pos + 1] === '"')) {
        // Could be r#"..."# or r"..."
        let hashCount = 0;
        let p = pos + 1;
        while (p < len && source[p] === '#') { hashCount++; p++; }
        if (p < len && source[p] === '"') {
          p++; // skip opening "
          const closing = '"' + '#'.repeat(hashCount);
          while (p < len) {
            const remain = source.slice(p);
            if (remain.startsWith(closing)) {
              p += closing.length;
              break;
            }
            p++;
          }
          tokens.push({ type: TT.RawString, value: source.slice(start, p), start, end: p });
          pos = p;
          continue;
        }
      }

      // Byte string: b"..." or br"..." or br#"..."#
      if (ch === 'b' && (source[pos + 1] === '"' || source[pos + 1] === '\'' || source[pos + 1] === 'r')) {
        if (source[pos + 1] === '"') {
          // b"..."
          pos += 2;
          while (pos < len && source[pos] !== '"') {
            if (source[pos] === '\\') pos++; // skip escape
            pos++;
          }
          if (pos < len) pos++; // skip closing "
          tokens.push({ type: TT.ByteString, value: source.slice(start, pos), start, end: pos });
          continue;
        }
        if (source[pos + 1] === 'r') {
          // br"..." or br#"..."#
          let hashCount = 0;
          let p = pos + 2;
          while (p < len && source[p] === '#') { hashCount++; p++; }
          if (p < len && source[p] === '"') {
            p++;
            const closing = '"' + '#'.repeat(hashCount);
            while (p < len) {
              if (source.slice(p).startsWith(closing)) {
                p += closing.length;
                break;
              }
              p++;
            }
            tokens.push({ type: TT.ByteString, value: source.slice(start, p), start, end: p });
            pos = p;
            continue;
          }
        }
        if (source[pos + 1] === '\'') {
          // b'x' byte literal
          pos += 2;
          if (pos < len && source[pos] === '\\') pos++;
          pos++;
          if (pos < len && source[pos] === '\'') pos++;
          tokens.push({ type: TT.Char, value: source.slice(start, pos), start, end: pos });
          continue;
        }
      }

      // String literal
      if (ch === '"') {
        pos++;
        while (pos < len && source[pos] !== '"') {
          if (source[pos] === '\\') pos++;
          pos++;
        }
        if (pos < len) pos++; // closing "
        tokens.push({ type: TT.String, value: source.slice(start, pos), start, end: pos });
        continue;
      }

      // Char literal vs lifetime
      if (ch === '\'') {
        // Look ahead to distinguish 'a (lifetime) from 'a' (char)
        // Lifetime: 'ident not followed by '
        // Char: 'x' or '\n' or '\x41' etc.
        const afterQuote = source.slice(pos + 1);
        // Check for char literal: 'x' or '\...'
        if (afterQuote.length >= 2) {
          if (afterQuote[0] === '\\') {
            // Escaped char: '\n', '\x41', '\u{1F600}', etc.
            let p = pos + 2;
            // Skip escape sequence
            if (source[p] === 'x') p += 3; // \xNN
            else if (source[p] === 'u') {
              p++;
              if (source[p] === '{') {
                while (p < len && source[p] !== '}') p++;
                p++;
              }
            } else {
              p++; // simple escape like \n, \t
            }
            if (p < len && source[p] === '\'') {
              p++;
              tokens.push({ type: TT.Char, value: source.slice(start, p), start, end: p });
              pos = p;
              continue;
            }
          } else if (afterQuote[1] === '\'') {
            // Simple char: 'a'
            pos += 3;
            tokens.push({ type: TT.Char, value: source.slice(start, pos), start, end: pos });
            continue;
          }
        }
        // Must be a lifetime
        pos++;
        if (pos < len && /[a-zA-Z_]/.test(source[pos])) {
          while (pos < len && /[a-zA-Z0-9_]/.test(source[pos])) pos++;
          tokens.push({ type: TT.Lifetime, value: source.slice(start, pos), start, end: pos });
          continue;
        }
        // Bare ' — treat as symbol
        tokens.push({ type: TT.Symbol, value: "'", start, end: pos });
        continue;
      }

      // Number literal
      if (/[0-9]/.test(ch)) {
        // Handle 0x, 0o, 0b prefixes
        if (ch === '0' && pos + 1 < len && /[xXoObB]/.test(source[pos + 1])) {
          pos += 2;
          while (pos < len && /[0-9a-fA-F_]/.test(source[pos])) pos++;
        } else {
          while (pos < len && /[0-9_.]/.test(source[pos])) {
            if (source[pos] === '.' && pos + 1 < len && source[pos + 1] === '.') break; // range operator
            pos++;
          }
          // Exponent
          if (pos < len && /[eE]/.test(source[pos])) {
            pos++;
            if (pos < len && /[+-]/.test(source[pos])) pos++;
            while (pos < len && /[0-9_]/.test(source[pos])) pos++;
          }
        }
        // Type suffix (i32, u64, f64, etc.)
        if (pos < len && /[a-zA-Z]/.test(source[pos])) {
          while (pos < len && /[a-zA-Z0-9_]/.test(source[pos])) pos++;
        }
        tokens.push({ type: TT.Number, value: source.slice(start, pos), start, end: pos });
        continue;
      }

      // Identifier or keyword
      if (/[a-zA-Z_]/.test(ch)) {
        while (pos < len && /[a-zA-Z0-9_]/.test(source[pos])) pos++;
        const word = source.slice(start, pos);
        const type = KEYWORDS.has(word) ? TT.Keyword : TT.Ident;
        tokens.push({ type, value: word, start, end: pos });
        continue;
      }

      // Multi-char symbols
      const twoChar = source.slice(pos, pos + 3);
      if (twoChar === '<<=' || twoChar === '>>=') {
        pos += 3;
        tokens.push({ type: TT.Symbol, value: twoChar, start, end: pos });
        continue;
      }
      const dblChar = source.slice(pos, pos + 2);
      const dblSymbols = ['::', '->', '=>', '..', '..=', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
      if (dblSymbols.includes(dblChar)) {
        pos += 2;
        tokens.push({ type: TT.Symbol, value: dblChar, start, end: pos });
        continue;
      }

      // Single-char symbols
      pos++;
      tokens.push({ type: TT.Symbol, value: ch, start, end: pos });
    }

    tokens.push({ type: TT.EOF, value: '', start: pos, end: pos });
    return tokens;
  }


  // ==========================================
  // Analyzer
  // ==========================================

  /**
   * Analyze Rust source code and return memory entries
   * Each entry: { name, type, segment, reason, line, size, details, connections }
   */
  function analyze(source) {
    const tokens = tokenize(source);
    const meaningful = tokens.filter(t => t.type !== TT.Whitespace && t.type !== TT.Comment);

    const entries = [];
    const timeline = [];
    const lines = source.split('\n');
    let scopeStack = []; // track nested scopes (fn, block, etc.)
    let currentFn = null;
    let stepNum = 0;

    // Helper: get line number from char position
    function lineOf(pos) {
      let line = 1;
      for (let i = 0; i < pos && i < source.length; i++) {
        if (source[i] === '\n') line++;
      }
      return line;
    }

    // Helper: estimate size for a type name
    function sizeOf(typeName) {
      if (!typeName) return null;
      const base = typeName.replace(/<.*>/, '').replace(/&.*/, '').trim();
      if (TYPE_SIZES[base] !== undefined) return TYPE_SIZES[base];
      if (STACK_PRIMITIVES.has(base)) return TYPE_SIZES[base] || 8;
      return null;
    }

    // Helper: determine if a type name implies heap allocation
    function isHeapType(typeName) {
      if (!typeName) return false;
      const base = typeName.replace(/<.*>/, '').trim();
      if (HEAP_TYPES.has(base)) return true;
      // Check for Box<dyn ...>
      if (typeName.startsWith('Box<')) return true;
      if (typeName.startsWith('Vec<')) return true;
      if (typeName.startsWith('String')) return true;
      if (typeName.startsWith('Rc<')) return true;
      if (typeName.startsWith('Arc<')) return true;
      if (typeName.startsWith('HashMap<')) return true;
      if (typeName.startsWith('BTreeMap<')) return true;
      if (typeName.startsWith('HashSet<')) return true;
      if (typeName.startsWith('BTreeSet<')) return true;
      if (typeName.startsWith('Mutex<')) return true;
      if (typeName.startsWith('RwLock<')) return true;
      if (typeName.startsWith('PathBuf')) return true;
      if (typeName.startsWith('OsString')) return true;
      if (typeName.startsWith('CString')) return true;
      if (typeName.startsWith('VecDeque<')) return true;
      if (typeName.startsWith('LinkedList<')) return true;
      if (typeName.startsWith('BinaryHeap<')) return true;
      return false;
    }

    // Helper: classify what a right-hand side expression allocates
    function classifyRHS(tokensSlice) {
      if (tokensSlice.length === 0) return { segment: 'stack', reason: 'default allocation' };

      const first = tokensSlice[0];
      const exprText = tokensSlice.map(t => t.value).join('');

      // String literal
      if (first.type === TT.String || first.type === TT.RawString) {
        return { segment: 'rodata', reason: 'string literal embedded in binary', heapData: null };
      }

      // Byte string literal
      if (first.type === TT.ByteString) {
        return { segment: 'rodata', reason: 'byte string literal embedded in binary' };
      }

      // Numeric literal
      if (first.type === TT.Number) {
        return { segment: 'stack', reason: 'numeric value stored on stack' };
      }

      // Char literal
      if (first.type === TT.Char) {
        return { segment: 'stack', reason: 'char value stored on stack (4 bytes)' };
      }

      // Boolean literal
      if (first.type === TT.Keyword && (first.value === 'true' || first.value === 'false')) {
        return { segment: 'stack', reason: 'boolean stored on stack (1 byte)' };
      }

      // Check for known heap-allocating patterns
      // Box::new(...)
      if (exprText.match(/^Box\s*::\s*new\s*\(/)) {
        return {
          segment: 'stack+heap',
          reason: 'Box: pointer on stack (8 bytes), data on heap',
          stackSize: 8,
          heapData: 'boxed value',
        };
      }

      // Vec::new() or Vec::with_capacity(...)
      if (exprText.match(/^Vec\s*::\s*(new|with_capacity|from)\s*\(/) ||
          exprText.match(/^Vec\s*::<[^>]*>\s*::\s*(new|with_capacity|from)\s*\(/)) {
        return {
          segment: 'stack+heap',
          reason: 'Vec: (ptr, len, cap) on stack (24 bytes), buffer on heap',
          stackSize: 24,
          heapData: 'dynamic buffer',
        };
      }

      // vec![...] macro
      if (first.type === TT.Ident && first.value === 'vec' &&
          tokensSlice.length > 1 && tokensSlice[1].value === '!') {
        // Try to count elements
        let elementCount = 0;
        let hasRepeat = false;
        let repeatCount = null;
        for (let i = 0; i < tokensSlice.length; i++) {
          if (tokensSlice[i].value === ',' || tokensSlice[i].value === ']') elementCount++;
          if (tokensSlice[i].value === ';') {
            hasRepeat = true;
            if (i + 1 < tokensSlice.length && tokensSlice[i + 1].type === TT.Number) {
              repeatCount = parseInt(tokensSlice[i + 1].value);
            }
          }
        }
        const sizeNote = hasRepeat && repeatCount ?
          `buffer for ${repeatCount} elements on heap` : 'dynamic buffer on heap';
        return {
          segment: 'stack+heap',
          reason: `vec! macro: (ptr, len, cap) on stack (24 bytes), ${sizeNote}`,
          stackSize: 24,
          heapData: sizeNote,
        };
      }

      // String::from(...) or String::new() or "...".to_string() or "...".to_owned()
      if (exprText.match(/^String\s*::\s*(from|new|with_capacity)\s*\(/) ||
          exprText.match(/^String\s*::<[^>]*>\s*::\s*(from|new)\s*\(/)) {
        return {
          segment: 'stack+heap',
          reason: 'String: (ptr, len, cap) on stack (24 bytes), UTF-8 buffer on heap',
          stackSize: 24,
          heapData: 'UTF-8 buffer',
        };
      }

      // .to_string() or .to_owned() on a literal
      if (exprText.match(/\.to_string\s*\(\)/) || exprText.match(/\.to_owned\s*\(\)/)) {
        return {
          segment: 'stack+heap',
          reason: 'Creates owned String: (ptr, len, cap) on stack (24 bytes), buffer on heap',
          stackSize: 24,
          heapData: 'owned string buffer',
        };
      }

      // format!(...) macro
      if (first.type === TT.Ident && first.value === 'format' &&
          tokensSlice.length > 1 && tokensSlice[1].value === '!') {
        return {
          segment: 'stack+heap',
          reason: 'format! produces String: (ptr, len, cap) on stack (24 bytes), buffer on heap',
          stackSize: 24,
          heapData: 'formatted string buffer',
        };
      }

      // HashMap::new(), BTreeMap::new(), etc.
      for (const heapType of HEAP_TYPES) {
        const re = new RegExp(`^${heapType}\\s*(?:::<[^>]*>)?\\s*::\\s*(new|from|with_capacity|default)\\s*\\(`);
        if (exprText.match(re)) {
          const stackSz = TYPE_SIZES[heapType] || 24;
          return {
            segment: 'stack+heap',
            reason: `${heapType}: metadata on stack (${stackSz} bytes), data on heap`,
            stackSize: stackSz,
            heapData: `${heapType} internal storage`,
          };
        }
      }

      // Rc::new(...), Arc::new(...), Rc::clone(...), Arc::clone(...)
      if (exprText.match(/^(Rc|Arc)\s*::\s*(new|clone)\s*\(/)) {
        const wrapper = exprText.match(/^(Rc|Arc)/)[1];
        const method = exprText.match(/::\s*(new|clone)/)[1];
        const desc = wrapper === 'Rc' ? 'reference-counted' : 'atomic reference-counted';
        const detail = method === 'clone'
          ? `${wrapper}::clone increments refcount, new pointer on stack (8 bytes)`
          : `${wrapper}: pointer on stack (8 bytes), ${desc} data + refcount on heap`;
        return {
          segment: 'stack+heap',
          reason: detail,
          stackSize: 8,
          heapData: method === 'clone' ? `shared ${desc} allocation (refcount++)` : `${desc} allocation`,
        };
      }

      // Box::pin(...)
      if (exprText.match(/^Box\s*::\s*pin\s*\(/)) {
        return {
          segment: 'stack+heap',
          reason: 'Box::pin: Pin<Box<T>> pointer on stack (8 bytes), pinned data on heap',
          stackSize: 8,
          heapData: 'pinned heap allocation',
        };
      }

      // Mutex::new(...), RwLock::new(...)
      if (exprText.match(/^(Mutex|RwLock)\s*::\s*new\s*\(/)) {
        const lock = exprText.startsWith('Mutex') ? 'Mutex' : 'RwLock';
        return {
          segment: 'stack+heap',
          reason: `${lock}: lock metadata on stack, protected data on heap (when wrapped in Arc)`,
          stackSize: 8,
          heapData: `${lock}-protected data`,
        };
      }

      // RefCell::new(...) or Cell::new(...)
      if (exprText.match(/^(RefCell|Cell)\s*::\s*new\s*\(/)) {
        const wrapper = exprText.startsWith('RefCell') ? 'RefCell' : 'Cell';
        return {
          segment: 'stack',
          reason: `${wrapper}: interior mutability wrapper, data stays on stack (borrow checked at runtime)`,
        };
      }

      // Cow::Borrowed / Cow::Owned
      if (exprText.match(/^Cow\s*::\s*Borrowed\s*\(/)) {
        return {
          segment: 'stack',
          reason: 'Cow::Borrowed: no heap allocation, just a reference (fat pointer on stack)',
          stackSize: 24,
        };
      }
      if (exprText.match(/^Cow\s*::\s*Owned\s*\(/)) {
        return {
          segment: 'stack+heap',
          reason: 'Cow::Owned: metadata on stack (24 bytes), owned data on heap',
          stackSize: 24,
          heapData: 'Cow owned data',
        };
      }

      // Array literal [expr; N] or [a, b, c]
      if (first.value === '[') {
        // Check for repeat [expr; N]
        for (let i = 0; i < tokensSlice.length; i++) {
          if (tokensSlice[i].value === ';' && i + 1 < tokensSlice.length) {
            return { segment: 'stack', reason: 'fixed-size array allocated on stack' };
          }
        }
        return { segment: 'stack', reason: 'fixed-size array allocated on stack' };
      }

      // Tuple (a, b, c)
      if (first.value === '(') {
        return { segment: 'stack', reason: 'tuple allocated on stack' };
      }

      // Struct instantiation: SomeName { ... } or SomeName(...)
      if (first.type === TT.Ident && !KEYWORDS.has(first.value)) {
        // Check if followed by { or (
        if (tokensSlice.length > 1) {
          if (tokensSlice[1].value === '{' || tokensSlice[1].value === '(') {
            // Check if the type is a known heap type
            if (isHeapType(first.value)) {
              return {
                segment: 'stack+heap',
                reason: `${first.value}: metadata on stack, data on heap`,
                stackSize: TYPE_SIZES[first.value] || 24,
                heapData: `${first.value} storage`,
              };
            }
            return {
              segment: 'stack',
              reason: `struct ${first.value}: value type allocated on stack`,
            };
          }
          // Check for Type::method(...) patterns
          if (tokensSlice[1].value === '::') {
            const typeName = first.value;
            if (isHeapType(typeName)) {
              return {
                segment: 'stack+heap',
                reason: `${typeName}: metadata on stack, data on heap`,
                stackSize: TYPE_SIZES[typeName] || 24,
                heapData: `${typeName} storage`,
              };
            }
          }
        }

        // Might be a function call or variable reference
        return { segment: 'stack', reason: 'value type — assumed stack allocation' };
      }

      // Reference &expr or &mut expr
      if (first.value === '&') {
        return {
          segment: 'stack',
          reason: 'reference: pointer stored on stack (8 bytes), data lives elsewhere',
          stackSize: 8,
        };
      }

      // Dereference or unary ops
      if (first.value === '*' || first.value === '-' || first.value === '!') {
        return { segment: 'stack', reason: 'computed value on stack' };
      }

      // move/async/unsafe block
      if (first.value === 'move' || first.value === 'async' || first.value === 'unsafe') {
        return { segment: 'stack', reason: 'block expression, result on stack' };
      }

      // Closure
      if (first.value === '|') {
        return {
          segment: 'stack',
          reason: 'closure: capture struct on stack, code in .text',
          extra: { segment: 'text', name: '(closure body)', reason: 'closure code compiled to .text' },
        };
      }

      // match/if/loop expressions
      if (first.value === 'match' || first.value === 'if' || first.value === 'loop' || first.value === 'while' || first.value === 'for') {
        return { segment: 'stack', reason: `${first.value} expression result on stack` };
      }

      // Default fallback
      return { segment: 'stack', reason: 'inferred stack allocation' };
    }

    // Helper: parse a type annotation (after :) into a string
    function parseTypeAnnotation(toks, startIdx) {
      let angleDepth = 0;
      let bracketDepth = 0;
      let typeStr = '';
      let i = startIdx;
      while (i < toks.length) {
        const t = toks[i];
        if (t.value === '<') angleDepth++;
        if (t.value === '>') angleDepth--;
        if (t.value === '[') bracketDepth++;
        if (t.value === ']') bracketDepth--;
        // Only stop at these delimiters when NOT inside <> or []
        if (angleDepth === 0 && bracketDepth === 0 &&
            (t.value === '=' || t.value === ',' || t.value === ')' || t.value === '{')) break;
        // Also stop at ; only when not inside brackets (array types use ;)
        if (angleDepth === 0 && bracketDepth === 0 && t.value === ';') break;
        if (angleDepth < 0) break;
        typeStr += t.value;
        i++;
      }
      return { typeStr: typeStr.trim(), endIdx: i };
    }

    // Helper: collect RHS tokens until ; or unmatched )
    function collectRHS(toks, startIdx) {
      let depth = 0;
      let braceDepth = 0;
      let bracketDepth = 0;
      const result = [];
      let i = startIdx;
      while (i < toks.length) {
        const t = toks[i];
        if (t.value === '(') depth++;
        if (t.value === ')') { depth--; if (depth < 0) break; }
        if (t.value === '{') braceDepth++;
        if (t.value === '}') { braceDepth--; if (braceDepth < 0) break; }
        if (t.value === '[') bracketDepth++;
        if (t.value === ']') { bracketDepth--; if (bracketDepth < 0) break; }
        if (t.value === ';' && depth === 0 && braceDepth === 0 && bracketDepth === 0) break;
        result.push(t);
        i++;
      }
      return { tokens: result, endIdx: i };
    }

    // ==========================================
    // Main analysis pass
    // ==========================================

    for (let i = 0; i < meaningful.length; i++) {
      const tok = meaningful[i];
      const line = lineOf(tok.start);

      // ---- Skip visibility & safety modifiers ----
      // pub, pub(crate), pub(super), async, unsafe — skip ahead to the actual keyword
      if (tok.type === TT.Keyword && tok.value === 'pub') {
        // Check for pub(crate), pub(super), pub(in path)
        if (i + 1 < meaningful.length && meaningful[i + 1].value === '(') {
          let depth = 1;
          let j = i + 2;
          while (j < meaningful.length && depth > 0) {
            if (meaningful[j].value === '(') depth++;
            if (meaningful[j].value === ')') depth--;
            j++;
          }
          i = j - 1; // will be incremented by for loop
        }
        continue;
      }

      if (tok.type === TT.Keyword && (tok.value === 'async' || tok.value === 'unsafe') &&
          i + 1 < meaningful.length && meaningful[i + 1].value === 'fn') {
        continue; // skip, let the `fn` handler pick it up
      }

      if (tok.type === TT.Keyword && tok.value === 'extern') {
        // extern "C" fn ... or extern crate ...
        continue;
      }

      // ---- fn declaration ----
      if (tok.type === TT.Keyword && tok.value === 'fn') {
        // Collect function name
        let fnName = '(anonymous)';
        let j = i + 1;
        while (j < meaningful.length && meaningful[j].type === TT.Whitespace) j++;
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          fnName = meaningful[j].value;
        }

        currentFn = fnName;

        // Add .text entry for the function
        entries.push({
          id: `text_fn_${fnName}_${line}`,
          name: `fn ${fnName}()`,
          type: 'function',
          segment: 'text',
          reason: `Function body compiled to machine code in .text segment`,
          line: line,
          size: null,
          details: `Code for fn ${fnName} lives in the .text (code) segment of the binary`,
          connections: [],
        });

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `fn ${fnName}() entered`,
          detail: 'Stack frame created',
          segment: 'text',
          line: line,
          entryId: `text_fn_${fnName}_${line}`,
        });

        // Parse parameters
        // Find opening (
        while (j < meaningful.length && meaningful[j].value !== '(') j++;
        if (j < meaningful.length) {
          j++; // skip (
          let paramDepth = 1;
          let paramName = null;
          let colonSeen = false;

          while (j < meaningful.length && paramDepth > 0) {
            const pt = meaningful[j];
            if (pt.value === '(') paramDepth++;
            if (pt.value === ')') { paramDepth--; if (paramDepth === 0) break; }

            if (pt.value === ':' && paramDepth === 1) {
              colonSeen = true;
              j++;
              // Parse param type
              const { typeStr, endIdx } = parseTypeAnnotation(meaningful, j);
              if (paramName && paramName !== 'self' && paramName !== '&self' && paramName !== '&mut self') {
                const paramSegment = isHeapType(typeStr) ? 'stack+heap' : 'stack';
                const paramReason = isHeapType(typeStr)
                  ? `Parameter ${paramName}: ${typeStr} metadata on stack, data on heap`
                  : `Parameter ${paramName}: ${typeStr} passed on stack`;

                entries.push({
                  id: `stack_param_${paramName}_${line}`,
                  name: paramName,
                  type: typeStr || 'unknown',
                  segment: paramSegment === 'stack+heap' ? 'stack' : 'stack',
                  reason: paramReason,
                  line: line,
                  size: sizeOf(typeStr),
                  details: `Function parameter in ${fnName}'s stack frame`,
                  connections: [],
                  scope: fnName,
                });

                if (isHeapType(typeStr)) {
                  entries.push({
                    id: `heap_param_${paramName}_${line}`,
                    name: `*${paramName}`,
                    type: `${typeStr} data`,
                    segment: 'heap',
                    reason: `Heap data owned by parameter ${paramName}`,
                    line: line,
                    size: null,
                    details: `Heap allocation referenced by ${paramName}`,
                    connections: [{ from: `stack_param_${paramName}_${line}`, to: `heap_param_${paramName}_${line}`, label: 'owns' }],
                    scope: fnName,
                  });
                }

                stepNum++;
                timeline.push({
                  step: stepNum,
                  action: `param ${paramName}: ${typeStr}`,
                  detail: paramReason,
                  segment: 'stack',
                  line: line,
                  entryId: `stack_param_${paramName}_${line}`,
                });
              }
              j = endIdx;
              paramName = null;
              colonSeen = false;
              continue;
            }

            if (pt.value === ',' && paramDepth === 1) {
              paramName = null;
              colonSeen = false;
              j++;
              continue;
            }

            if (!colonSeen && (pt.type === TT.Ident || pt.value === '&' || pt.value === 'mut')) {
              if (pt.type === TT.Ident) {
                if (pt.value === 'mut') {
                  // skip mut, next ident is the name
                } else if (pt.value === 'self') {
                  paramName = 'self';
                } else {
                  paramName = pt.value;
                }
              }
            }

            j++;
          }
        }

        continue;
      }

      // ---- let binding ----
      if (tok.type === TT.Keyword && tok.value === 'let') {
        let j = i + 1;
        let isMut = false;

        // Check for mut
        if (j < meaningful.length && meaningful[j].value === 'mut') {
          isMut = true;
          j++;
        }

        // Collect variable name (may be a pattern)
        let varName = '';
        let patternNames = [];

        if (j < meaningful.length) {
          // Handle destructuring: let (a, b) = ...; let Struct { x, y } = ...;
          if (meaningful[j].value === '(' || meaningful[j].value === '{') {
            // Destructuring pattern
            const opener = meaningful[j].value;
            const closer = opener === '(' ? ')' : '}';
            let depth = 1;
            j++;
            while (j < meaningful.length && depth > 0) {
              if (meaningful[j].value === opener) depth++;
              if (meaningful[j].value === closer) { depth--; if (depth === 0) break; }
              if (meaningful[j].type === TT.Ident && depth === 1 && !KEYWORDS.has(meaningful[j].value)) {
                patternNames.push(meaningful[j].value);
              }
              j++;
            }
            if (j < meaningful.length) j++; // skip closer
            varName = patternNames.join(', ');
          } else if (meaningful[j].value === '_') {
            varName = '_';
            j++;
          } else if (meaningful[j].type === TT.Ident) {
            varName = meaningful[j].value;
            j++;
          }
        }

        if (!varName) continue;

        // Check for type annotation
        let typeAnnotation = null;
        if (j < meaningful.length && meaningful[j].value === ':') {
          j++;
          const { typeStr, endIdx } = parseTypeAnnotation(meaningful, j);
          typeAnnotation = typeStr;
          j = endIdx;
        }

        // Check for = (assignment)
        let rhsClassification = null;
        if (j < meaningful.length && meaningful[j].value === '=') {
          j++;
          const { tokens: rhsTokens, endIdx } = collectRHS(meaningful, j);
          rhsClassification = classifyRHS(rhsTokens);
          j = endIdx;
        }

        // Determine segment based on type annotation and RHS
        // RHS classification takes priority when available (it's more specific)
        let segment, reason, size, heapData, extraEntries = [];

        if (rhsClassification) {
          if (rhsClassification.segment === 'stack+heap') {
            segment = 'stack';
            reason = rhsClassification.reason;
            size = rhsClassification.stackSize || null;

            extraEntries.push({
              id: `heap_${varName}_${line}`,
              name: `*${varName}`,
              type: rhsClassification.heapData || 'heap data',
              segment: 'heap',
              reason: `Heap data owned by ${varName}`,
              line: line,
              size: null,
              details: rhsClassification.reason,
              connections: [{ from: `stack_${varName}_${line}`, to: `heap_${varName}_${line}`, label: 'owns' }],
              scope: currentFn,
            });
          } else if (rhsClassification.segment === 'rodata') {
            // String literal bound to a &str
            segment = 'stack';
            reason = 'reference (&str) on stack, literal data in .rodata';
            size = 16; // fat pointer: ptr + len

            extraEntries.push({
              id: `rodata_${varName}_${line}`,
              name: `"${varName}" literal`,
              type: '&str data',
              segment: 'rodata',
              reason: rhsClassification.reason,
              line: line,
              size: null,
              details: 'String literal baked into the binary at compile time',
              connections: [{ from: `stack_${varName}_${line}`, to: `rodata_${varName}_${line}`, label: 'points to' }],
              scope: null,
            });
          } else {
            segment = rhsClassification.segment;
            reason = rhsClassification.reason;
            size = rhsClassification.stackSize || sizeOf(typeAnnotation) || null;
          }

          // Handle extra (like closure body in .text)
          if (rhsClassification.extra) {
            extraEntries.push({
              id: `text_closure_${varName}_${line}`,
              name: rhsClassification.extra.name || `${varName} code`,
              type: 'closure',
              segment: rhsClassification.extra.segment,
              reason: rhsClassification.extra.reason,
              line: line,
              size: null,
              details: 'Closure body compiled to code',
              connections: [],
              scope: currentFn,
            });
          }
        } else if (typeAnnotation && isHeapType(typeAnnotation)) {
          // Type annotation says heap, no RHS to be more specific
          segment = 'stack';
          reason = `${typeAnnotation}: metadata on stack`;
          size = sizeOf(typeAnnotation);

          extraEntries.push({
            id: `heap_${varName}_${line}`,
            name: `*${varName}`,
            type: `${typeAnnotation} data`,
            segment: 'heap',
            reason: `Heap-allocated data owned by ${varName}`,
            line: line,
            size: null,
            details: `Dynamic data for ${typeAnnotation}`,
            connections: [{ from: `stack_${varName}_${line}`, to: `heap_${varName}_${line}`, label: 'owns' }],
            scope: currentFn,
          });
        } else if (typeAnnotation) {
          segment = 'stack';
          reason = `${typeAnnotation} stored on stack`;
          size = sizeOf(typeAnnotation);
        } else {
          segment = 'stack';
          reason = 'local variable on stack';
          size = null;
        }

        // Skip underscore bindings that are intentionally unused
        if (varName === '_') continue;

        const entryId = `stack_${varName}_${line}`;

        entries.push({
          id: entryId,
          name: isMut ? `mut ${varName}` : varName,
          type: typeAnnotation || (rhsClassification ? 'inferred' : 'unknown'),
          segment: segment,
          reason: reason,
          line: line,
          size: size,
          details: `${isMut ? 'Mutable' : 'Immutable'} local variable in ${currentFn || 'global'} scope`,
          connections: extraEntries.length > 0 ?
            [{ from: entryId, to: extraEntries[0]?.id, label: extraEntries[0]?.segment === 'heap' ? 'owns' : 'points to' }] : [],
          scope: currentFn,
        });

        for (const extra of extraEntries) {
          entries.push(extra);
        }

        stepNum++;
        const sizeStr = size ? ` (${size} bytes)` : '';
        timeline.push({
          step: stepNum,
          action: `let ${isMut ? 'mut ' : ''}${varName}${typeAnnotation ? ': ' + typeAnnotation : ''}`,
          detail: `${reason}${sizeStr}`,
          segment: segment,
          line: line,
          entryId: entryId,
        });

        // Timeline entries for heap allocations
        for (const extra of extraEntries) {
          stepNum++;
          timeline.push({
            step: stepNum,
            action: `  -> ${extra.segment} alloc for ${varName}`,
            detail: extra.reason,
            segment: extra.segment,
            line: line,
            entryId: extra.id,
          });
        }

        continue;
      }

      // ---- const declaration ----
      if (tok.type === TT.Keyword && tok.value === 'const') {
        let j = i + 1;
        let constName = '';
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          constName = meaningful[j].value;
          j++;
        }
        if (!constName) continue;

        let typeAnnotation = null;
        if (j < meaningful.length && meaningful[j].value === ':') {
          j++;
          const { typeStr, endIdx } = parseTypeAnnotation(meaningful, j);
          typeAnnotation = typeStr;
          j = endIdx;
        }

        entries.push({
          id: `rodata_const_${constName}_${line}`,
          name: `const ${constName}`,
          type: typeAnnotation || 'unknown',
          segment: 'rodata',
          reason: 'const values are inlined at use sites or placed in .rodata',
          line: line,
          size: sizeOf(typeAnnotation),
          details: 'Compile-time constant — the compiler may inline this value everywhere it is used, or place it in the read-only data segment',
          connections: [],
          scope: null,
        });

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `const ${constName}${typeAnnotation ? ': ' + typeAnnotation : ''}`,
          detail: 'Compile-time constant in .rodata (may be inlined)',
          segment: 'rodata',
          line: line,
          entryId: `rodata_const_${constName}_${line}`,
        });

        continue;
      }

      // ---- static declaration ----
      if (tok.type === TT.Keyword && tok.value === 'static') {
        let j = i + 1;
        let isMut = false;

        if (j < meaningful.length && meaningful[j].value === 'mut') {
          isMut = true;
          j++;
        }

        let staticName = '';
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          staticName = meaningful[j].value;
          j++;
        }
        if (!staticName) continue;

        let typeAnnotation = null;
        if (j < meaningful.length && meaningful[j].value === ':') {
          j++;
          const { typeStr, endIdx } = parseTypeAnnotation(meaningful, j);
          typeAnnotation = typeStr;
          j = endIdx;
        }

        // Check for zero initialization (goes to .bss)
        let isZero = false;
        if (j < meaningful.length && meaningful[j].value === '=') {
          j++;
          const { tokens: rhsTokens } = collectRHS(meaningful, j);
          const rhsText = rhsTokens.map(t => t.value).join('').trim();
          isZero = rhsText === '0' || rhsText === '0i32' || rhsText === '0u32' ||
                   rhsText === '0i64' || rhsText === '0u64' || rhsText === '0usize' ||
                   rhsText === 'false' || rhsText.match(/^\[0;\d+\]$/) ||
                   rhsText.match(/^\[0u8;\d+\]$/);
        }

        let segment, reason;
        if (isMut) {
          segment = isZero ? 'bss' : 'data';
          reason = isZero
            ? 'static mut zero-initialized — stored in .bss (no binary space cost)'
            : 'static mut — mutable global stored in .data segment';
        } else {
          segment = isZero ? 'bss' : 'rodata';
          reason = isZero
            ? 'static zero-initialized — stored in .bss'
            : 'immutable static — stored in .rodata (read-only data)';
        }

        entries.push({
          id: `${segment}_static_${staticName}_${line}`,
          name: `static ${isMut ? 'mut ' : ''}${staticName}`,
          type: typeAnnotation || 'unknown',
          segment: segment,
          reason: reason,
          line: line,
          size: sizeOf(typeAnnotation),
          details: `Static variable with 'static lifetime — lives for the entire program duration. ${isMut ? 'UNSAFE: requires unsafe block to access.' : ''}`,
          connections: [],
          scope: null,
        });

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `static ${isMut ? 'mut ' : ''}${staticName}${typeAnnotation ? ': ' + typeAnnotation : ''}`,
          detail: reason,
          segment: segment,
          line: line,
          entryId: `${segment}_static_${staticName}_${line}`,
        });

        continue;
      }

      // ---- struct definition ----
      if (tok.type === TT.Keyword && tok.value === 'struct') {
        let j = i + 1;
        let structName = '';
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          structName = meaningful[j].value;
        }
        if (!structName) continue;

        // Note: struct definitions don't allocate memory themselves,
        // but we track them for the .text segment (type metadata)
        entries.push({
          id: `text_struct_${structName}_${line}`,
          name: `struct ${structName}`,
          type: 'type definition',
          segment: 'text',
          reason: 'Type definition — no runtime allocation. Instances are allocated when created.',
          line: line,
          size: null,
          details: `Struct definition. Memory is allocated when instances are created (let x = ${structName} { ... })`,
          connections: [],
          scope: null,
        });

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `struct ${structName} defined`,
          detail: 'Type definition (no allocation, layout determined at compile time)',
          segment: 'text',
          line: line,
          entryId: `text_struct_${structName}_${line}`,
        });

        continue;
      }

      // ---- enum definition ----
      if (tok.type === TT.Keyword && tok.value === 'enum') {
        let j = i + 1;
        let enumName = '';
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          enumName = meaningful[j].value;
        }
        if (!enumName) continue;

        entries.push({
          id: `text_enum_${enumName}_${line}`,
          name: `enum ${enumName}`,
          type: 'type definition',
          segment: 'text',
          reason: 'Enum definition — sized by largest variant + discriminant tag',
          line: line,
          size: null,
          details: `Enum type. Size = max(variant sizes) + discriminant. Instances go on stack (unless boxed).`,
          connections: [],
          scope: null,
        });

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `enum ${enumName} defined`,
          detail: 'Type definition (sized by largest variant + discriminant)',
          segment: 'text',
          line: line,
          entryId: `text_enum_${enumName}_${line}`,
        });

        continue;
      }

      // ---- impl block ----
      if (tok.type === TT.Keyword && tok.value === 'impl') {
        let j = i + 1;
        let implTarget = '';
        // Skip generic params
        if (j < meaningful.length && meaningful[j].value === '<') {
          let depth = 1;
          j++;
          while (j < meaningful.length && depth > 0) {
            if (meaningful[j].value === '<') depth++;
            if (meaningful[j].value === '>') depth--;
            j++;
          }
        }
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          implTarget = meaningful[j].value;
        }

        // Check for trait impl: impl Trait for Type
        let traitName = null;
        let k = j + 1;
        while (k < meaningful.length && meaningful[k].value !== '{' && meaningful[k].value !== ';') {
          if (meaningful[k].value === 'for' && meaningful[k].type === TT.Keyword) {
            traitName = implTarget;
            k++;
            if (k < meaningful.length && meaningful[k].type === TT.Ident) {
              implTarget = meaningful[k].value;
            }
            break;
          }
          k++;
        }

        const label = traitName ? `impl ${traitName} for ${implTarget}` : `impl ${implTarget}`;

        entries.push({
          id: `text_impl_${implTarget}_${line}`,
          name: label,
          type: 'impl block',
          segment: 'text',
          reason: `Method implementations compiled to .text. ${traitName ? 'Trait methods may generate vtable entries in .rodata.' : ''}`,
          line: line,
          size: null,
          details: `Implementation block. Methods are compiled to machine code.${traitName ? ' Vtable for dynamic dispatch stored in .rodata.' : ''}`,
          connections: traitName ? [{
            from: `text_impl_${implTarget}_${line}`,
            to: `rodata_vtable_${traitName}_${implTarget}_${line}`,
            label: 'vtable',
          }] : [],
          scope: null,
        });

        if (traitName) {
          entries.push({
            id: `rodata_vtable_${traitName}_${implTarget}_${line}`,
            name: `vtable(${traitName})`,
            type: 'vtable',
            segment: 'rodata',
            reason: 'Virtual method dispatch table for trait object — stored in .rodata',
            line: line,
            size: null,
            details: `Vtable for dyn ${traitName} pointing to ${implTarget}'s method implementations`,
            connections: [],
            scope: null,
          });
        }

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `${label}`,
          detail: 'Methods compiled to .text',
          segment: 'text',
          line: line,
          entryId: `text_impl_${implTarget}_${line}`,
        });

        continue;
      }

      // ---- trait definition ----
      if (tok.type === TT.Keyword && tok.value === 'trait') {
        let j = i + 1;
        let traitName = '';
        if (j < meaningful.length && meaningful[j].type === TT.Ident) {
          traitName = meaningful[j].value;
        }
        if (!traitName) continue;

        entries.push({
          id: `text_trait_${traitName}_${line}`,
          name: `trait ${traitName}`,
          type: 'trait definition',
          segment: 'text',
          reason: 'Trait definition — generates vtable layout for dynamic dispatch',
          line: line,
          size: null,
          details: 'Trait definition. When used as dyn Trait, a vtable is created in .rodata for dispatch.',
          connections: [],
          scope: null,
        });

        stepNum++;
        timeline.push({
          step: stepNum,
          action: `trait ${traitName} defined`,
          detail: 'Trait definition (vtable layout for dyn dispatch)',
          segment: 'text',
          line: line,
          entryId: `text_trait_${traitName}_${line}`,
        });

        continue;
      }

      // ---- type alias ----
      if (tok.type === TT.Keyword && tok.value === 'type') {
        // type aliases don't generate runtime code, skip
        continue;
      }

      // ---- use declaration ----
      if (tok.type === TT.Keyword && tok.value === 'use') {
        // Imports don't generate memory entries, skip
        continue;
      }

      // ---- mod declaration ----
      if (tok.type === TT.Keyword && tok.value === 'mod') {
        // Module declarations are compile-time, skip
        continue;
      }

      // ---- Standalone string literals (like in println!) ----
      if (tok.type === TT.String || tok.type === TT.RawString || tok.type === TT.ByteString) {
        // Check if this is inside a macro call or expression
        // We track standalone string literals that appear in common macros
        // Look back for a macro invocation
        let inMacro = false;
        let macroName = '';
        for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
          if (meaningful[k].value === '!') {
            if (k > 0 && meaningful[k - 1].type === TT.Ident) {
              inMacro = true;
              macroName = meaningful[k - 1].value;
            }
            break;
          }
        }

        if (inMacro && (macroName === 'println' || macroName === 'print' || macroName === 'eprintln' ||
                        macroName === 'eprint' || macroName === 'write' || macroName === 'writeln' ||
                        macroName === 'panic' || macroName === 'assert' || macroName === 'assert_eq' ||
                        macroName === 'debug_assert' || macroName === 'log' || macroName === 'info' ||
                        macroName === 'warn' || macroName === 'error' || macroName === 'trace')) {
          const literalContent = tok.value.slice(1, -1); // Remove quotes
          const truncated = literalContent.length > 20 ? literalContent.slice(0, 20) + '...' : literalContent;

          entries.push({
            id: `rodata_literal_${line}_${tok.start}`,
            name: `"${truncated}"`,
            type: '&str',
            segment: 'rodata',
            reason: `Format string literal in ${macroName}! — embedded in binary .rodata`,
            line: line,
            size: literalContent.length,
            details: `String literal used by ${macroName}! macro. Stored in read-only data segment at compile time.`,
            connections: [],
            scope: currentFn,
          });

          stepNum++;
          timeline.push({
            step: stepNum,
            action: `${macroName}!("${truncated}")`,
            detail: 'Format string literal in .rodata',
            segment: 'rodata',
            line: line,
            entryId: `rodata_literal_${line}_${tok.start}`,
          });
        }

        continue;
      }

      // ---- Scope tracking for drop analysis ----
      if (tok.value === '}') {
        // When a scope closes, variables in that scope are dropped
        // Find entries in current scope that need cleanup
        if (currentFn) {
          const scopeEntries = entries.filter(e =>
            e.scope === currentFn && e.segment === 'stack' &&
            e.connections && e.connections.length > 0
          );

          // Check if this closes the function body
          // (Simplified: we just check if this might be the end of the current function)
          // A more robust approach would track brace depth per function
        }
      }
    }

    // Add drop timeline entries at the end (reverse order for LIFO)
    const heapEntries = entries.filter(e => e.segment === 'heap');
    if (heapEntries.length > 0) {
      stepNum++;
      timeline.push({
        step: stepNum,
        action: 'scope ends — drop order (LIFO)',
        detail: `${heapEntries.length} heap allocation(s) freed in reverse order`,
        segment: 'drop',
        line: null,
        entryId: null,
      });

      for (const he of [...heapEntries].reverse()) {
        stepNum++;
        timeline.push({
          step: stepNum,
          action: `  drop ${he.name}`,
          detail: 'Heap memory freed, destructor runs',
          segment: 'drop',
          line: he.line,
          entryId: he.id,
        });
      }
    }

    return { entries, timeline, tokens: meaningful };
  }


  // ==========================================
  // Public API
  // ==========================================

  return {
    analyze,
    tokenize,
    TT,
    HEAP_TYPES,
    STACK_PRIMITIVES,
  };

})();
