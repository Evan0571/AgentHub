// Unit test for flattenLocalImports (mirror in scripts/smoke-preview-multi.mjs).
// Run: node scripts/test-flatten-imports.mjs

function stubForBinding(binding) {
  const decls = [];
  let rest = binding.trim();
  if (rest && !rest.startsWith('{') && !rest.startsWith('*')) {
    const m = /^([a-zA-Z_$][\w$]*)/.exec(rest);
    if (m) {
      decls.push(`const ${m[1]} = undefined;`);
      rest = rest.slice(m[0].length).trim();
      if (rest.startsWith(',')) rest = rest.slice(1).trim();
    }
  }
  const ns = /^\*\s+as\s+([a-zA-Z_$][\w$]*)/.exec(rest);
  if (ns) {
    decls.push(`const ${ns[1]} = {};`);
    rest = rest.slice(ns[0].length).trim();
  }
  const nm = /^\{\s*([^}]+)\s*\}/.exec(rest);
  if (nm) {
    const names = nm[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    for (const n of names) decls.push(`const ${n} = undefined;`);
  }
  return decls.join(' ');
}

function flatten(code, known) {
  code = code.replace(
    /^(\s*)import\s+(['"])(\.\.?\/[^'"]+)\2(\s*;?\s*)$/gm,
    (full, indent, q, importPath, suffix) => {
      const base = importPath.split('/').pop().replace(/\.(tsx?|jsx?|vue)$/i, '');
      if (known.has(base)) return `${indent}import ${q}${base}${q}${suffix}`;
      return `${indent}/* stripped ${importPath} */`;
    },
  );
  code = code.replace(
    /^(\s*)import\s+([^'"\n]+?)\s+from\s+(['"])(\.\.?\/[^'"]+)\3(\s*;?\s*)$/gm,
    (full, indent, binding, q, importPath, suffix) => {
      const base = importPath.split('/').pop().replace(/\.(tsx?|jsx?|vue)$/i, '');
      if (known.has(base)) return `${indent}import ${binding} from ${q}${base}${q}${suffix}`;
      return `${indent}/* stripped ${importPath} */ ${stubForBinding(binding)}`;
    },
  );
  return code;
}

const sample = `import React, { useState } from 'react';
import TodoList from './TodoList';
import './App.css';
import logoUrl from './logo.svg';
import { Button, Input as Inp } from './ui';
import * as Utils from './utils';

function App() { return <div>{logoUrl}<Button/></div>; }
`;

const known = new Set(['TodoList']);
const out = flatten(sample, known);
console.log(out);
console.log('---');
const checks = [
  { name: 'React import preserved', ok: out.includes("import React, { useState } from 'react'") },
  { name: 'TodoList bare-rewritten', ok: out.includes("import TodoList from 'TodoList'") },
  { name: 'CSS side-effect stripped', ok: out.includes('/* stripped ./App.css */') && !out.includes("'./App.css'") },
  { name: 'logo.svg stubbed', ok: /\/\* stripped \.\/logo\.svg \*\/ const logoUrl = undefined;/.test(out) },
  { name: 'named imports stubbed', ok: out.includes('const Button = undefined;') && out.includes('const Inp = undefined;') },
  { name: 'namespace import stubbed', ok: out.includes('const Utils = {};') },
];
let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.name}`);
  if (!c.ok) failed++;
}
process.exit(failed > 0 ? 1 : 0);
