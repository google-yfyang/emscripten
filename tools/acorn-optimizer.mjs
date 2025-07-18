#!/usr/bin/env node

import * as acorn from 'acorn';
import * as terser from '../third_party/terser/terser.js';
import * as fs from 'node:fs';
import assert from 'node:assert';
import {parseArgs} from 'node:util';

// Utilities

function read(x) {
  return fs.readFileSync(x, 'utf-8');
}

function assertAt(condition, node, message = '') {
  if (!condition) {
    if (!process.env.EMCC_DEBUG_SAVE) {
      message += ' (use EMCC_DEBUG_SAVE=1 to preserve temporary inputs)';
    }
    let err = new Error(message);
    err['loc'] = acorn.getLineInfo(input, node.start);
    throw err;
  }
}

// Visits and walks
// (We don't use acorn-walk because it ignores x in 'x = y'.)

function visitChildren(node, c) {
  // emptyOut() and temporary ignoring may mark nodes as empty,
  // while they have properties with children we should ignore.
  if (node.type === 'EmptyStatement') {
    return;
  }
  function maybeChild(child) {
    if (typeof child?.type === 'string') {
      c(child);
      return true;
    }
    return false;
  }
  for (const child of Object.values(node)) {
    // Check for a child.
    if (!maybeChild(child)) {
      // Check for an array of children.
      if (Array.isArray(child)) {
        child.forEach(maybeChild);
      }
    }
  }
}

// Simple post-order walk, calling properties on an object by node type,
// if the type exists.
function simpleWalk(node, cs) {
  visitChildren(node, (child) => simpleWalk(child, cs));
  if (node.type in cs) {
    cs[node.type](node);
  }
}

// Full post-order walk, calling a single function for all types. If |pre| is
// provided, it is called in pre-order (before children). If |pre| returns
// `false`, the node and its children will be skipped.
function fullWalk(node, c, pre) {
  if (pre?.(node) !== false) {
    visitChildren(node, (child) => fullWalk(child, c, pre));
    c(node);
  }
}

// Recursive post-order walk, calling properties on an object by node type,
// if the type exists, and if so leaving recursion to that function.
function recursiveWalk(node, cs) {
  (function c(node) {
    if (!(node.type in cs)) {
      visitChildren(node, (child) => recursiveWalk(child, cs));
    } else {
      cs[node.type](node, c);
    }
  })(node);
}

// AST Utilities

function emptyOut(node) {
  node.type = 'EmptyStatement';
}

function setLiteralValue(item, value) {
  item.value = value;
  item.raw = null;
}

function isLiteralString(node) {
  return node.type === 'Literal' && typeof node.value === 'string';
}

function dump(node) {
  console.log(JSON.stringify(node, null, ' '));
}

// Traverse a pattern node (identifier, object/array pattern, etc) invoking onExpr on any nested expressions and onBoundIdent on any bound identifiers.
function walkPattern(node, onExpr, onBoundIdent) {
  recursiveWalk(node, {
    AssignmentPattern(node, c) {
      c(node.left);
      onExpr(node.right);
    },
    Property(node, c) {
      if (node.computed) {
        onExpr(node.key);
      }
      c(node.value);
    },
    Identifier({name}) {
      onBoundIdent(name);
    },
  });
}

function hasSideEffects(node) {
  // Conservative analysis.
  let has = false;
  fullWalk(
    node,
    (node) => {
      switch (node.type) {
        case 'ExpressionStatement':
          if (node.directive) {
            has = true;
          }
          break;
        // TODO: go through all the ESTree spec
        case 'Literal':
        case 'Identifier':
        case 'UnaryExpression':
        case 'BinaryExpression':
        case 'LogicalExpression':
        case 'UpdateOperator':
        case 'ConditionalExpression':
        case 'VariableDeclaration':
        case 'VariableDeclarator':
        case 'ObjectExpression':
        case 'Property':
        case 'SpreadElement':
        case 'BlockStatement':
        case 'ArrayExpression':
        case 'EmptyStatement': {
          break; // safe
        }
        case 'MemberExpression': {
          // safe if on Math (or other familiar objects, TODO)
          if (node.object.type !== 'Identifier' || node.object.name !== 'Math') {
            // console.error('because member on ' + node.object.name);
            has = true;
          }
          break;
        }
        case 'NewExpression': {
          // default to unsafe, but can be safe on some familiar objects
          if (node.callee.type === 'Identifier') {
            const name = node.callee.name;
            if (
              name === 'TextDecoder' ||
              name === 'ArrayBuffer' ||
              name === 'Int8Array' ||
              name === 'Uint8Array' ||
              name === 'Int16Array' ||
              name === 'Uint16Array' ||
              name === 'Int32Array' ||
              name === 'Uint32Array' ||
              name === 'Float32Array' ||
              name === 'Float64Array'
            ) {
              // no side effects, but the arguments might (we walk them in
              // full walk as well)
              break;
            }
          }
          // not one of the safe cases
          has = true;
          break;
        }
        default: {
          has = true;
        }
      }
    },
    (node) =>
      // Ignore inner scopes.
      !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type),
  );
  return has;
}

// Passes

// Removes obviously-unused code. Similar to closure compiler in its rules -
// export e.g. by Module['..'] = theThing; , or use it somewhere, otherwise
// it goes away.
//
// Note that this is somewhat conservative, since the ESTree AST does not
// have a simple separation between definitions and uses, e.g.
// Identifier is used both for the x in  function foo(x) {
// and for  y = x + 1 . That means we need to consider new ES6+ constructs
// as they appear (like ArrowFunctionExpression). Instead, we do a conservative
// analysis here.

function JSDCE(ast, aggressive) {
  function iteration() {
    let removed = 0;
    const scopes = [{}]; // begin with empty toplevel scope
    function ensureData(scope, name) {
      if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
      scope[name] = {
        def: 0,
        use: 0,
        param: 0, // true for function params, which cannot be eliminated
      };
      return scope[name];
    }
    function cleanUp(ast, names) {
      recursiveWalk(ast, {
        ForStatement(node, c) {
          visitChildren(node, c);
          // If we had `for (var x = ...; ...)` and we removed `x`, we need to change to `for (; ...)`.
          if (node.init?.type === 'EmptyStatement') {
            node.init = null;
          }
        },
        ForInStatement(node, c) {
          // We can't remove the var in a for-in, as that would result in an invalid syntax. Skip the LHS.
          c(node.right);
          c(node.body);
        },
        ForOfStatement(node, c) {
          // We can't remove the var in a for-of, as that would result in an invalid syntax. Skip the LHS.
          c(node.right);
          c(node.body);
        },
        VariableDeclaration(node, _c) {
          let removedHere = 0;
          node.declarations = node.declarations.filter((node) => {
            assert(node.type === 'VariableDeclarator');
            let keep = node.init && hasSideEffects(node.init);
            walkPattern(
              node.id,
              (value) => {
                keep ||= hasSideEffects(value);
              },
              (boundName) => {
                keep ||= !names.has(boundName);
              },
            );
            if (!keep) removedHere = 1;
            return keep;
          });
          removed += removedHere;
          if (node.declarations.length === 0) {
            emptyOut(node);
          }
        },
        ExpressionStatement(node, _c) {
          if (aggressive && !hasSideEffects(node)) {
            emptyOut(node);
            removed++;
          }
        },
        FunctionDeclaration(node, _c) {
          if (names.has(node.id.name)) {
            removed++;
            emptyOut(node);
            return;
          }
          // do not recurse into other scopes
        },
        // do not recurse into other scopes
        FunctionExpression() {},
        ArrowFunctionExpression() {},
      });
    }

    function handleFunction(node, c, defun) {
      // defun names matter - function names (the y in var x = function y() {..}) are just for stack traces.
      if (defun) {
        ensureData(scopes[scopes.length - 1], node.id.name).def = 1;
      }
      const scope = {};
      scopes.push(scope);
      for (const param of node.params) {
        walkPattern(param, c, (name) => {
          ensureData(scope, name).def = 1;
          scope[name].param = 1;
        });
      }
      c(node.body);
      // we can ignore self-references, i.e., references to ourselves inside
      // ourselves, for named defined (defun) functions
      const ownName = defun ? node.id.name : '';
      const names = new Set();
      for (const name in scopes.pop()) {
        if (name === ownName) continue;
        const data = scope[name];
        if (data.use && !data.def) {
          // this is used from a higher scope, propagate the use down
          ensureData(scopes[scopes.length - 1], name).use = 1;
          continue;
        }
        if (data.def && !data.use && !data.param) {
          // this is eliminateable!
          names.add(name);
        }
      }
      cleanUp(node.body, names);
    }

    recursiveWalk(ast, {
      VariableDeclarator(node, c) {
        walkPattern(node.id, c, (name) => {
          ensureData(scopes[scopes.length - 1], name).def = 1;
        });
        if (node.init) c(node.init);
      },
      ObjectExpression(node, c) {
        // ignore the property identifiers
        node.properties.forEach((node) => {
          if (node.value) {
            c(node.value);
          } else if (node.argument) {
            c(node.argument);
          }
        });
      },
      MemberExpression(node, c) {
        c(node.object);
        // Ignore a property identifier (a.X), but notice a[X] (computed props).
        if (node.computed) {
          c(node.property);
        }
      },
      FunctionDeclaration(node, c) {
        handleFunction(node, c, true /* defun */);
      },
      FunctionExpression(node, c) {
        handleFunction(node, c);
      },
      ArrowFunctionExpression(node, c) {
        handleFunction(node, c);
      },
      Identifier(node, _c) {
        const name = node.name;
        ensureData(scopes[scopes.length - 1], name).use = 1;
      },
      ExportDefaultDeclaration(node, c) {
        const name = node.declaration.id.name;
        ensureData(scopes[scopes.length - 1], name).use = 1;
        c(node.declaration);
      },
      ExportNamedDeclaration(node, c) {
        if (node.declaration) {
          if (node.declaration.type == 'FunctionDeclaration') {
            const name = node.declaration.id.name;
            ensureData(scopes[scopes.length - 1], name).use = 1;
          } else {
            assert(node.declaration.type == 'VariableDeclaration');
            for (const decl of node.declaration.declarations) {
              const name = decl.id.name;
              ensureData(scopes[scopes.length - 1], name).use = 1;
            }
          }
          c(node.declaration);
        } else {
          for (const specifier of node.specifiers) {
            const name = specifier.local.name;
            ensureData(scopes[scopes.length - 1], name).use = 1;
          }
        }
      },
    });

    // toplevel
    const scope = scopes.pop();
    assert(scopes.length === 0);

    const names = new Set();
    for (const [name, data] of Object.entries(scope)) {
      if (data.def && !data.use) {
        assert(!data.param); // can't be
        // this is eliminateable!
        names.add(name);
      }
    }
    cleanUp(ast, names);
    return removed;
  }
  while (iteration() && aggressive) {} // eslint-disable-line no-empty
}

// Aggressive JSDCE - multiple iterations
function AJSDCE(ast) {
  JSDCE(ast, /* aggressive= */ true);
}

function isWasmImportsAssign(node) {
  // var wasmImports = ..
  //   or
  // wasmImports = ..
  if (
    node.type === 'AssignmentExpression' &&
    node.left.name == 'wasmImports' &&
    node.right.type == 'ObjectExpression'
  ) {
    return true;
  }
  return (
    node.type === 'VariableDeclaration' &&
    node.declarations.length === 1 &&
    node.declarations[0].id.name === 'wasmImports' &&
    node.declarations[0].init &&
    node.declarations[0].init.type === 'ObjectExpression'
  );
}

function getWasmImportsValue(node) {
  if (node.declarations) {
    return node.declarations[0].init;
  } else {
    return node.right;
  }
}

function isExportUse(node) {
  // Match usages of symbols on the `wasmExports` object. e.g:
  //   wasmExports['X']
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    isLiteralString(node.property) &&
    node.object.name === 'wasmExports'
  );
}

function getExportOrModuleUseName(node) {
  return node.property.value;
}

function isModuleUse(node) {
  return (
    node.type === 'MemberExpression' && // Module['X']
    node.object.type === 'Identifier' &&
    node.object.name === 'Module' &&
    isLiteralString(node.property)
  );
}

// Apply import/export name changes (after minifying them)
function applyImportAndExportNameChanges(ast) {
  const mapping = extraInfo.mapping;
  fullWalk(ast, (node) => {
    if (isWasmImportsAssign(node)) {
      const assignedObject = getWasmImportsValue(node);
      assignedObject.properties.forEach((item) => {
        if (mapping[item.key.name]) {
          item.key.name = mapping[item.key.name];
        }
      });
    } else if (node.type === 'AssignmentExpression') {
      const value = node.right;
      if (isExportUse(value)) {
        const name = value.property.value;
        if (mapping[name]) {
          setLiteralValue(value.property, mapping[name]);
        }
      }
    } else if (node.type === 'CallExpression' && isExportUse(node.callee)) {
      // wasmExports["___wasm_call_ctors"](); -> wasmExports["M"]();
      const callee = node.callee;
      const name = callee.property.value;
      if (mapping[name]) {
        setLiteralValue(callee.property, mapping[name]);
      }
    } else if (isExportUse(node)) {
      const prop = node.property;
      const name = prop.value;
      if (mapping[name]) {
        setLiteralValue(prop, mapping[name]);
      }
    }
  });
}

// A static dyncall is dynCall('vii', ..), which is actually static even
// though we call dynCall() - we see the string signature statically.
function isStaticDynCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'dynCall' &&
    isLiteralString(node.arguments[0])
  );
}

function getStaticDynCallName(node) {
  return 'dynCall_' + node.arguments[0].value;
}

// a dynamic dyncall is one in which all we know is *some* dynCall may
// be called, but not who. This can be either
//   dynCall(*not a string*, ..)
// or, to be conservative,
//   "dynCall_"
// as that prefix means we may be constructing a dynamic dyncall name
// (dynCall and embind's requireFunction do this internally).
function isDynamicDynCall(node) {
  return (
    (node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'dynCall' &&
      !isLiteralString(node.arguments[0])) ||
    (isLiteralString(node) && node.value === 'dynCall_')
  );
}

//
// Emit the DCE graph, to help optimize the combined JS+wasm.
// This finds where JS depends on wasm, and where wasm depends
// on JS, and prints that out.
//
// The analysis here is simplified, and not completely general. It
// is enough to optimize the common case of JS library and runtime
// functions involved in loops with wasm, but not more complicated
// things like JS objects and sub-functions. Specifically we
// analyze as follows:
//
//  * We consider (1) the toplevel scope, and (2) the scopes of toplevel defined
//    functions (defun, not function; i.e., function X() {} where
//    X can be called later, and not y = function Z() {} where Z is
//    just a name for stack traces). We also consider the wasm, which
//    we can see things going to and arriving from.
//  * Anything used in a defun creates a link in the DCE graph, either
//    to another defun, or the wasm.
//  * Anything used in the toplevel scope is rooted, as it is code
//    we assume will execute. The exceptions are
//     * when we receive something from wasm; those are "free" and
//       do not cause rooting. (They will become roots if they are
//       exported, the metadce logic will handle that.)
//     * when we send something to wasm; sending a defun causes a
//       link in the DCE graph.
//  * Anything not in the toplevel or not in a toplevel defun is
//    considering rooted. We don't optimize those cases.
//
// Special handling:
//
//  * dynCall('vii', ..) are dynamic dynCalls, but we analyze them
//    statically, to preserve the dynCall_vii etc. method they depend on.
//    Truly dynamic dynCalls (not to a string constant) will not work,
//    and require the user to export them.
//  * Truly dynamic dynCalls are assumed to reach any dynCall_*.
//
// XXX this modifies the input AST. if you want to keep using it,
//     that should be fixed. Currently the main use case here does
//     not require that. TODO FIXME
//
function emitDCEGraph(ast) {
  // First pass: find the wasm imports and exports, and the toplevel
  // defuns, and save them on the side, removing them from the AST,
  // which makes the second pass simpler.
  //
  // The imports that wasm receives look like this:
  //
  //  var wasmImports = { "abort": abort, "assert": assert, [..] };
  //
  // The exports are trickier, as they have a different form whether or not
  // async compilation is enabled. It can be either:
  //
  //  var _malloc = Module['_malloc'] = wasmExports['_malloc'];
  //
  // or
  //
  //  var _malloc = wasmExports['_malloc'];
  //
  // or
  //
  //  var _malloc = Module['_malloc'] = (x) => wasmExports['_malloc'](x);
  //
  // or, in the minimal runtime, it looks like
  //
  //  function assignWasmExports(wasmExports)
  //   ..
  //   _malloc = wasmExports["malloc"];
  //   ..
  //  });
  const imports = [];
  const defuns = [];
  const dynCallNames = [];
  const nameToGraphName = {};
  const modulePropertyToGraphName = {};
  const exportNameToGraphName = {}; // identical to wasmExports['..'] nameToGraphName
  let foundWasmImportsAssign = false;
  let foundMinimalRuntimeExports = false;

  function saveAsmExport(name, asmName) {
    // the asmName is what the wasm provides directly; the outside JS
    // name may be slightly different (extra "_" in wasm backend)
    const graphName = getGraphName(name, 'export');
    nameToGraphName[name] = graphName;
    modulePropertyToGraphName[name] = graphName;
    exportNameToGraphName[asmName] = graphName;
    if (/^dynCall_/.test(name)) {
      dynCallNames.push(graphName);
    }
  }

  // We track defined functions very carefully, so that we can remove them and
  // the things they call, but other function scopes (like arrow functions and
  // object methods) are trickier to track (object methods require knowing what
  // object a function name is called on), so we do not track those. We consider
  // all content inside them as top-level, which means it is used.
  var specialScopes = 0;

  fullWalk(
    ast,
    (node) => {
      if (isWasmImportsAssign(node)) {
        const assignedObject = getWasmImportsValue(node);
        assignedObject.properties.forEach((item) => {
          let value = item.value;
          if (value.type === 'Literal' || value.type === 'FunctionExpression') {
            return; // if it's a numeric or function literal, nothing to do here
          }
          if (value.type === 'LogicalExpression') {
            // We may have something like  wasmMemory || Module.wasmMemory  in pthreads code;
            // use the left hand identifier.
            value = value.left;
          }
          assertAt(value.type === 'Identifier', value);
          const nativeName = item.key.type == 'Literal' ? item.key.value : item.key.name;
          assert(nativeName);
          imports.push([value.name, nativeName]);
        });
        foundWasmImportsAssign = true;
        emptyOut(node); // ignore this in the second pass; this does not root
      } else if (node.type === 'AssignmentExpression') {
        const target = node.left;
        // Ignore assignment to the wasmExports object (as happens in
        // applySignatureConversions).
        if (isExportUse(target)) {
          emptyOut(node);
        }
      } else if (node.type === 'VariableDeclaration') {
        if (node.declarations.length === 1) {
          const item = node.declarations[0];
          const name = item.id.name;
          const value = item.init;
          if (value && isExportUse(value)) {
            const asmName = getExportOrModuleUseName(value);
            // this is:
            //  var _x = wasmExports['x'];
            saveAsmExport(name, asmName);
            emptyOut(node);
          } else if (value && value.type === 'AssignmentExpression') {
            const assigned = value.left;
            if (isModuleUse(assigned) && getExportOrModuleUseName(assigned) === name) {
              // this is
              //  var x = Module['x'] = ?
              // which looks like a wasm export being received. confirm with the asm use
              let found = 0;
              let asmName;
              fullWalk(value.right, (node) => {
                if (isExportUse(node)) {
                  found++;
                  asmName = getExportOrModuleUseName(node);
                }
              });
              // in the wasm backend, the asm name may have one fewer "_" prefixed
              if (found === 1) {
                // this is indeed an export
                // the asmName is what the wasm provides directly; the outside JS
                // name may be slightly different (extra "_" in wasm backend)
                saveAsmExport(name, asmName);
                emptyOut(node); // ignore this in the second pass; this does not root
                return;
              }
              if (value.right.type === 'Literal') {
                // this is
                //  var x = Module['x'] = 1234;
                // this form occurs when global addresses are exported from the
                // module.  It doesn't constitute a usage.
                assertAt(typeof value.right.value === 'number', value.right);
                emptyOut(node);
              }
            }
          }
        }
        // A variable declaration that has no initial values can be ignored in
        // the second pass, these are just declarations, not roots - an actual
        // use must be found in order to root.
        if (!node.declarations.reduce((hasInit, decl) => hasInit || !!decl.init, false)) {
          emptyOut(node);
        }
      } else if (node.type === 'FunctionDeclaration') {
        const name = node.id.name;
        // Check if this is the minimal runtime exports function, which looks like
        //   function assignWasmExports(wasmExports)
        if (
          name == 'assignWasmExports' &&
          node.params.length === 1 &&
          node.params[0].type === 'Identifier' &&
          node.params[0].name === 'wasmExports'
        ) {
          // This looks very much like what we are looking for.
          const body = node.body.body;
          assert(!foundMinimalRuntimeExports);
          foundMinimalRuntimeExports = true;
          for (let i = 0; i < body.length; i++) {
            const item = body[i];
            if (
              item.type === 'ExpressionStatement' &&
              item.expression.type === 'AssignmentExpression' &&
              item.expression.operator === '=' &&
              item.expression.left.type === 'Identifier' &&
              item.expression.right.type === 'MemberExpression' &&
              item.expression.right.object.type === 'Identifier' &&
              item.expression.right.object.name === 'wasmExports' &&
              item.expression.right.property.type === 'Literal'
            ) {
              const name = item.expression.left.name;
              const asmName = item.expression.right.property.value;
              saveAsmExport(name, asmName);
              emptyOut(item); // ignore all this in the second pass; this does not root
            }
          }
        } else if (!specialScopes) {
          defuns.push(node);
          nameToGraphName[name] = getGraphName(name, 'defun');
          emptyOut(node); // ignore this in the second pass; we scan defuns separately
        }
      } else if (node.type === 'ArrowFunctionExpression') {
        assert(specialScopes > 0);
        specialScopes--;
      } else if (node.type === 'Property' && node.method) {
        assert(specialScopes > 0);
        specialScopes--;
      }
    },
    (node) => {
      // Pre-walking logic. We note special scopes (see above).
      if (node.type === 'ArrowFunctionExpression' || (node.type === 'Property' && node.method)) {
        specialScopes++;
      }
    },
  );
  // Scoping must balance out.
  assert(specialScopes === 0);
  // We must have found the info we need.
  assert(
    foundWasmImportsAssign,
    'could not find the assignment to "wasmImports". perhaps --pre-js or --post-js code moved it out of the global scope? (things like that should be done after emcc runs, as they do not need to be run through the optimizer which is the special thing about --pre-js/--post-js code)',
  );
  // Read exports that were declared in extraInfo
  if (extraInfo) {
    for (const exp of extraInfo.exports) {
      saveAsmExport(exp[0], exp[1]);
    }
  }

  // Second pass: everything used in the toplevel scope is rooted;
  // things used in defun scopes create links
  function getGraphName(name, what) {
    return 'emcc$' + what + '$' + name;
  }
  const infos = {}; // the graph name of the item => info for it
  for (const [jsName, nativeName] of imports) {
    const name = getGraphName(jsName, 'import');
    const info = (infos[name] = {
      name: name,
      import: ['env', nativeName],
      reaches: new Set(),
    });
    if (nameToGraphName.hasOwnProperty(jsName)) {
      info.reaches.add(nameToGraphName[jsName]);
    } // otherwise, it's a number, ignore
  }
  for (const [e, _] of Object.entries(exportNameToGraphName)) {
    const name = exportNameToGraphName[e];
    infos[name] = {
      name: name,
      export: e,
      reaches: new Set(),
    };
  }
  // a function that handles a node we visit, in either a defun or
  // the toplevel scope (in which case the second param is not provided)
  function visitNode(node, defunInfo) {
    // TODO: scope awareness here. for now we just assume all uses are
    //       from the top scope, which might create more uses than needed
    let reached;
    if (node.type === 'Identifier') {
      const name = node.name;
      if (nameToGraphName.hasOwnProperty(name)) {
        reached = nameToGraphName[name];
      }
    } else if (isModuleUse(node)) {
      const name = getExportOrModuleUseName(node);
      if (modulePropertyToGraphName.hasOwnProperty(name)) {
        reached = modulePropertyToGraphName[name];
      }
    } else if (isStaticDynCall(node)) {
      reached = getGraphName(getStaticDynCallName(node), 'export');
    } else if (isDynamicDynCall(node)) {
      // this can reach *all* dynCall_* targets, we can't narrow it down
      reached = dynCallNames;
    } else if (isExportUse(node)) {
      // any remaining asm uses are always rooted in any case
      const name = getExportOrModuleUseName(node);
      if (exportNameToGraphName.hasOwnProperty(name)) {
        infos[exportNameToGraphName[name]].root = true;
      }
      return;
    }
    if (reached) {
      function addReach(reached) {
        if (defunInfo) {
          defunInfo.reaches.add(reached); // defun reaches it
        } else {
          if (infos[reached]) {
            infos[reached].root = true; // in global scope, root it
          } else {
            // An info might not exist for the identifier if it is missing, for
            // example, we might call Module.dynCall_vi in library code, but it
            // won't exist in a standalone (non-JS) build anyhow. We can ignore
            // it in that case as the JS won't be used, but warn to be safe.
            trace('metadce: missing declaration for ' + reached);
          }
        }
      }
      if (typeof reached === 'string') {
        addReach(reached);
      } else {
        reached.forEach(addReach);
      }
    }
  }
  defuns.forEach((defun) => {
    const name = getGraphName(defun.id.name, 'defun');
    const info = (infos[name] = {
      name: name,
      reaches: new Set(),
    });
    fullWalk(defun.body, (node) => visitNode(node, info));
  });
  fullWalk(ast, (node) => visitNode(node, null));
  // Final work: print out the graph
  // sort for determinism
  const graph = Object.entries(infos)
    .sort(([name1], [name2]) => (name1 > name2 ? 1 : -1))
    .map(([_name, info]) => ({
      ...info,
      reaches: Array.from(info.reaches).sort(),
    }));
  dump(graph);
}

// Apply graph removals from running wasm-metadce. This only removes imports and
// exports from JS side, effectively disentangling the wasm and JS sides that
// way (and we leave further DCE on the JS and wasm sides to their respective
// optimizers, closure compiler and binaryen).
function applyDCEGraphRemovals(ast) {
  const unusedExports = new Set(extraInfo.unusedExports);
  const unusedImports = new Set(extraInfo.unusedImports);
  const foundUnusedImports = new Set();
  const foundUnusedExports = new Set();
  trace('unusedExports:', unusedExports);
  trace('unusedImports:', unusedImports);

  fullWalk(ast, (node) => {
    if (isWasmImportsAssign(node)) {
      const assignedObject = getWasmImportsValue(node);
      assignedObject.properties = assignedObject.properties.filter((item) => {
        const name = item.key.name;
        const value = item.value;
        if (unusedImports.has(name)) {
          foundUnusedImports.add(name);
          return hasSideEffects(value);
        }
        return true;
      });
    } else if (node.type === 'ExpressionStatement') {
      let expr = node.expression;
      // Inside the assignWasmExports function we have
      //
      //   _x = wasmExports['x']
      //
      // or:
      //
      //   Module['_x'] = _x = wasmExports['x']
      //
      if (expr.type == 'AssignmentExpression' && expr.right.type == 'AssignmentExpression') {
        expr = expr.right;
      }
      if (expr.operator === '=' && expr.left.type === 'Identifier' && isExportUse(expr.right)) {
        const export_name = getExportOrModuleUseName(expr.right);
        if (unusedExports.has(export_name)) {
          emptyOut(node);
          foundUnusedExports.add(export_name);
        }
      }
    }
  });

  for (const i of unusedImports) {
    assert(foundUnusedImports.has(i), 'unused import not found: ' + i);
  }
  for (const e of unusedExports) {
    assert(foundUnusedExports.has(e), 'unused export not found: ' + e);
  }
}

function createLiteral(value) {
  return {
    type: 'Literal',
    value: value,
    raw: '' + value,
  };
}

function makeCallExpression(node, name, args) {
  Object.assign(node, {
    type: 'CallExpression',
    callee: {
      type: 'Identifier',
      name: name,
    },
    arguments: args,
  });
}

function isEmscriptenHEAP(name) {
  switch (name) {
    case 'HEAP8':
    case 'HEAPU8':
    case 'HEAP16':
    case 'HEAPU16':
    case 'HEAP32':
    case 'HEAPU32':
    case 'HEAP64':
    case 'HEAPU64':
    case 'HEAPF32':
    case 'HEAPF64': {
      return true;
    }
    default: {
      return false;
    }
  }
}

// Replaces each HEAP access with function call that uses DataView to enforce
// LE byte order for HEAP buffer
function littleEndianHeap(ast) {
  recursiveWalk(ast, {
    FunctionDeclaration(node, c) {
      // do not recurse into LE_HEAP_STORE, LE_HEAP_LOAD functions
      if (
        !(
          node.id.type === 'Identifier' &&
          (node.id.name.startsWith('LE_HEAP') || node.id.name.startsWith('LE_ATOMICS_'))
        )
      ) {
        c(node.body);
      }
    },
    VariableDeclarator(node, c) {
      if (!(node.id.type === 'Identifier' && node.id.name.startsWith('LE_ATOMICS_'))) {
        c(node.id);
        if (node.init) c(node.init);
      }
    },
    AssignmentExpression(node, c) {
      const target = node.left;
      const value = node.right;
      c(value);
      if (!isHEAPAccess(target)) {
        // not accessing the HEAP
        c(target);
      } else {
        // replace the heap access with LE_HEAP_STORE
        const name = target.object.name;
        const idx = target.property;
        switch (name) {
          case 'HEAP8':
          case 'HEAPU8': {
            // no action required - storing only 1 byte
            break;
          }
          case 'HEAP16': {
            // change "name[idx] = value" to "LE_HEAP_STORE_I16(idx*2, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_I16', [multiply(idx, 2), value]);
            break;
          }
          case 'HEAPU16': {
            // change "name[idx] = value" to "LE_HEAP_STORE_U16(idx*2, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_U16', [multiply(idx, 2), value]);
            break;
          }
          case 'HEAP32': {
            // change "name[idx] = value" to "LE_HEAP_STORE_I32(idx*4, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_I32', [multiply(idx, 4), value]);
            break;
          }
          case 'HEAPU32': {
            // change "name[idx] = value" to "LE_HEAP_STORE_U32(idx*4, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_U32', [multiply(idx, 4), value]);
            break;
          }
          case 'HEAP64': {
            // change "name[idx] = value" to "LE_HEAP_STORE_I64(idx*8, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_I64', [multiply(idx, 8), value]);
            break;
          }
          case 'HEAPU64': {
            // change "name[idx] = value" to "LE_HEAP_STORE_U64(idx*8, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_U64', [multiply(idx, 8), value]);
            break;
          }
          case 'HEAPF32': {
            // change "name[idx] = value" to "LE_HEAP_STORE_F32(idx*4, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_F32', [multiply(idx, 4), value]);
            break;
          }
          case 'HEAPF64': {
            // change "name[idx] = value" to "LE_HEAP_STORE_F64(idx*8, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_F64', [multiply(idx, 8), value]);
            break;
          }
        }
      }
    },
    CallExpression(node, c) {
      if (node.arguments) {
        for (var a of node.arguments) c(a);
      }
      if (
        // Atomics.X(args) -> LE_ATOMICS_X(args)
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Atomics' &&
        !node.callee.computed
      ) {
        makeCallExpression(
          node,
          'LE_ATOMICS_' + node.callee.property.name.toUpperCase(),
          node.arguments,
        );
      } else {
        c(node.callee);
      }
    },
    MemberExpression(node, c) {
      c(node.property);
      if (!isHEAPAccess(node)) {
        // not accessing the HEAP
        c(node.object);
      } else {
        // replace the heap access with LE_HEAP_LOAD
        const idx = node.property;
        switch (node.object.name) {
          case 'HEAP8':
          case 'HEAPU8': {
            // no action required - loading only 1 byte
            break;
          }
          case 'HEAP16': {
            // change "name[idx]" to "LE_HEAP_LOAD_I16(idx*2)"
            makeCallExpression(node, 'LE_HEAP_LOAD_I16', [multiply(idx, 2)]);
            break;
          }
          case 'HEAPU16': {
            // change "name[idx]" to "LE_HEAP_LOAD_U16(idx*2)"
            makeCallExpression(node, 'LE_HEAP_LOAD_U16', [multiply(idx, 2)]);
            break;
          }
          case 'HEAP32': {
            // change "name[idx]" to "LE_HEAP_LOAD_I32(idx*4)"
            makeCallExpression(node, 'LE_HEAP_LOAD_I32', [multiply(idx, 4)]);
            break;
          }
          case 'HEAPU32': {
            // change "name[idx]" to "LE_HEAP_LOAD_U32(idx*4)"
            makeCallExpression(node, 'LE_HEAP_LOAD_U32', [multiply(idx, 4)]);
            break;
          }
          case 'HEAP64': {
            // change "name[idx]" to "LE_HEAP_LOAD_I64(idx*8)"
            makeCallExpression(node, 'LE_HEAP_LOAD_I64', [multiply(idx, 8)]);
            break;
          }
          case 'HEAPU64': {
            // change "name[idx]" to "LE_HEAP_LOAD_U64(idx*8)"
            makeCallExpression(node, 'LE_HEAP_LOAD_U64', [multiply(idx, 8)]);
            break;
          }
          case 'HEAPF32': {
            // change "name[idx]" to "LE_HEAP_LOAD_F32(idx*4)"
            makeCallExpression(node, 'LE_HEAP_LOAD_F32', [multiply(idx, 4)]);
            break;
          }
          case 'HEAPF64': {
            // change "name[idx]" to "LE_HEAP_LOAD_F64(idx*8)"
            makeCallExpression(node, 'LE_HEAP_LOAD_F64', [multiply(idx, 8)]);
            break;
          }
        }
      }
    },
  });
}

// Instrument heap accesses to call growMemViews helper function, which allows
// pthreads + memory growth to work (we check if the memory was grown on another thread
// in each access), see #8365.
function growableHeap(ast) {
  recursiveWalk(ast, {
    ExportNamedDeclaration() {
      // Do not recurse export statements since we don't want to rewrite, for example, `export { HEAP32 }`
    },
    FunctionDeclaration(node, c) {
      // Do not recurse into the helper function itself.
      if (
        !(
          node.id.type === 'Identifier' &&
          (node.id.name === 'growMemViews' || node.id.name === 'LE_HEAP_UPDATE')
        )
      ) {
        c(node.body);
      }
    },
    AssignmentExpression(node) {
      if (node.left.type !== 'Identifier') {
        // Don't transform `HEAPxx =` assignments.
        growableHeap(node.left);
      }
      growableHeap(node.right);
    },
    VariableDeclarator(node) {
      // Don't transform the var declarations for HEAP8 etc
      // but do transform anything that sets a var to
      // something from HEAP8 etc
      if (node.init) {
        growableHeap(node.init);
      }
    },
    Identifier(node) {
      if (isEmscriptenHEAP(node.name)) {
        // Transform `HEAPxx` into `(growMemViews(), HEAPxx)`.
        // Important: don't just do `growMemViews(HEAPxx)` because `growMemViews` reassigns `HEAPxx`
        // and we want to get an updated value after that reassignment.
        Object.assign(node, {
          type: 'SequenceExpression',
          expressions: [
            {
              type: 'CallExpression',
              callee: {
                type: 'Identifier',
                name: 'growMemViews',
              },
              arguments: [],
            },
            {...node},
          ],
        });
      }
    },
  });
}

// Make all JS pointers unsigned. We do this by modifying things like
// HEAP32[X >> 2] to HEAP32[X >>> 2]. We also need to handle the case of
// HEAP32[X] and make that HEAP32[X >>> 0], things like subarray(), etc.
function unsignPointers(ast) {
  // Aside from the standard emscripten HEAP*s, also identify just "HEAP"/"heap"
  // as representing a heap. This can be used in JS library code in order
  // to get this pass to fix it up.
  function isHeap(name) {
    return isEmscriptenHEAP(name) || name === 'heap' || name === 'HEAP';
  }

  function unsign(node) {
    // The pointer is often a >> shift, which we can just turn into >>>
    if (node.type === 'BinaryExpression') {
      if (node.operator === '>>') {
        node.operator = '>>>';
        return node;
      }
    }
    // If nothing else worked out, add a new shift.
    return {
      type: 'BinaryExpression',
      left: node,
      operator: '>>>',
      right: {
        type: 'Literal',
        value: 0,
      },
    };
  }

  fullWalk(ast, (node) => {
    if (node.type === 'MemberExpression') {
      // Check if this is HEAP*[?]
      if (node.object.type === 'Identifier' && isHeap(node.object.name) && node.computed) {
        node.property = unsign(node.property);
      }
    } else if (node.type === 'CallExpression') {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        isHeap(node.callee.object.name) &&
        !node.callee.computed
      ) {
        // This is a call on HEAP*.?. Specific things we need to fix up are
        // subarray, set, and copyWithin. TODO more?
        if (node.callee.property.name === 'set') {
          if (node.arguments.length >= 2) {
            node.arguments[1] = unsign(node.arguments[1]);
          }
        } else if (node.callee.property.name === 'subarray') {
          if (node.arguments.length >= 1) {
            node.arguments[0] = unsign(node.arguments[0]);
            if (node.arguments.length >= 2) {
              node.arguments[1] = unsign(node.arguments[1]);
            }
          }
        } else if (node.callee.property.name === 'copyWithin') {
          node.arguments[0] = unsign(node.arguments[0]);
          node.arguments[1] = unsign(node.arguments[1]);
          if (node.arguments.length >= 3) {
            node.arguments[2] = unsign(node.arguments[2]);
          }
        }
      }
    }
  });
}

function isHEAPAccess(node) {
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.computed && // notice a[X] but not a.X
    isEmscriptenHEAP(node.object.name)
  );
}

// Replace direct HEAP* loads/stores with calls into C, in which ASan checks
// are applied. That lets ASan cover JS too.
function asanify(ast) {
  recursiveWalk(ast, {
    FunctionDeclaration(node, c) {
      if (
        node.id.type === 'Identifier' &&
        (node.id.name.startsWith('_asan_js_') || node.id.name === 'establishStackSpace')
      ) {
        // do not recurse into this js impl function, which we use during
        // startup before the wasm is ready
      } else {
        c(node.body);
      }
    },
    AssignmentExpression(node, c) {
      const target = node.left;
      const value = node.right;
      c(value);
      if (isHEAPAccess(target)) {
        // Instrument a store.
        makeCallExpression(node, '_asan_js_store', [target.object, target.property, value]);
      } else {
        c(target);
      }
    },
    MemberExpression(node, c) {
      c(node.property);
      if (!isHEAPAccess(node)) {
        c(node.object);
      } else {
        // Instrument a load.
        makeCallExpression(node, '_asan_js_load', [node.object, node.property]);
      }
    },
  });
}

function multiply(value, by) {
  return {
    type: 'BinaryExpression',
    left: value,
    operator: '*',
    right: createLiteral(by),
  };
}

// Replace direct heap access with SAFE_HEAP* calls.
function safeHeap(ast) {
  recursiveWalk(ast, {
    FunctionDeclaration(node, c) {
      if (node.id.type === 'Identifier' && node.id.name.startsWith('SAFE_HEAP')) {
        // do not recurse into this js impl function, which we use during
        // startup before the wasm is ready
      } else {
        c(node.body);
      }
    },
    AssignmentExpression(node, c) {
      const target = node.left;
      const value = node.right;
      c(value);
      if (isHEAPAccess(target)) {
        // Instrument a store.
        makeCallExpression(node, 'SAFE_HEAP_STORE', [target.object, target.property, value]);
      } else {
        c(target);
      }
    },
    MemberExpression(node, c) {
      c(node.property);
      if (!isHEAPAccess(node)) {
        c(node.object);
      } else {
        // Instrument a load.
        makeCallExpression(node, 'SAFE_HEAP_LOAD', [node.object, node.property]);
      }
    },
  });
}

// Name minification

const RESERVED = new Set([
  'do',
  'if',
  'in',
  'for',
  'new',
  'try',
  'var',
  'env',
  'let',
  'case',
  'else',
  'enum',
  'void',
  'this',
  'void',
  'with',
]);
const VALID_MIN_INITS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const VALID_MIN_LATERS = VALID_MIN_INITS + '0123456789';

const minifiedNames = [];
const minifiedState = [0];

// Make sure the nth index in minifiedNames exists. Done 100% deterministically.
function ensureMinifiedNames(n) {
  while (minifiedNames.length < n + 1) {
    // generate the current name
    let name = VALID_MIN_INITS[minifiedState[0]];
    for (let i = 1; i < minifiedState.length; i++) {
      name += VALID_MIN_LATERS[minifiedState[i]];
    }
    if (!RESERVED.has(name)) minifiedNames.push(name);
    // increment the state
    let i = 0;
    while (true) {
      minifiedState[i]++;
      if (minifiedState[i] < (i === 0 ? VALID_MIN_INITS : VALID_MIN_LATERS).length) break;
      // overflow
      minifiedState[i] = 0;
      i++;
      // will become 0 after increment in next loop head
      if (i === minifiedState.length) minifiedState.push(-1);
    }
  }
}

function minifyLocals(ast) {
  // We are given a mapping of global names to their minified forms.
  assert(extraInfo?.globals);

  for (const fun of ast.body) {
    if (fun.type !== 'FunctionDeclaration') {
      continue;
    }
    // Find the list of local names, including params.
    const localNames = new Set();
    for (const param of fun.params) {
      localNames.add(param.name);
    }
    simpleWalk(fun, {
      VariableDeclaration(node, _c) {
        for (const dec of node.declarations) {
          localNames.add(dec.id.name);
        }
      },
    });

    function isLocalName(name) {
      return localNames.has(name);
    }

    // Names old to new names.
    const newNames = new Map();

    // The names in use, that must not be collided with.
    const usedNames = new Set();

    // Put the function name aside. We don't want to traverse it as it is not
    // in the scope of itself.
    const funId = fun.id;
    fun.id = null;

    // Find all the globals that we need to minify using pre-assigned names.
    // Don't actually minify them yet as that might interfere with local
    // variable names; just mark them as used, and what their new name will be.
    simpleWalk(fun, {
      Identifier(node, _c) {
        const name = node.name;
        if (!isLocalName(name)) {
          const minified = extraInfo.globals[name];
          if (minified) {
            newNames.set(name, minified);
            usedNames.add(minified);
          }
        }
      },
      CallExpression(node, _c) {
        // We should never call a local name, as in asm.js-style code our
        // locals are just numbers, not functions; functions are all declared
        // in the outer scope. If a local is called, that is a bug.
        if (node.callee.type === 'Identifier') {
          assertAt(!isLocalName(node.callee.name), node.callee, 'cannot call a local');
        }
      },
    });

    // The first time we encounter a local name, we assign it a/ minified name
    // that's not currently in use. Allocating on demand means they're processed
    // in a predictable order, which is very handy for testing/debugging
    // purposes.
    let nextMinifiedName = 0;

    function getNextMinifiedName() {
      while (true) {
        ensureMinifiedNames(nextMinifiedName);
        const minified = minifiedNames[nextMinifiedName++];
        // TODO: we can probably remove !isLocalName here
        if (!usedNames.has(minified) && !isLocalName(minified)) {
          return minified;
        }
      }
    }

    // Traverse and minify all names. First the function parameters.
    for (const param of fun.params) {
      const minified = getNextMinifiedName();
      newNames.set(param.name, minified);
      param.name = minified;
    }

    // Label minification is done in a separate namespace.
    const labelNames = new Map();
    let nextMinifiedLabel = 0;
    function getNextMinifiedLabel() {
      ensureMinifiedNames(nextMinifiedLabel);
      return minifiedNames[nextMinifiedLabel++];
    }

    // Finally, the function body.
    recursiveWalk(fun, {
      Identifier(node) {
        const name = node.name;
        if (newNames.has(name)) {
          node.name = newNames.get(name);
        } else if (isLocalName(name)) {
          const minified = getNextMinifiedName();
          newNames.set(name, minified);
          node.name = minified;
        }
      },
      LabeledStatement(node, c) {
        if (!labelNames.has(node.label.name)) {
          labelNames.set(node.label.name, getNextMinifiedLabel());
        }
        node.label.name = labelNames.get(node.label.name);
        c(node.body);
      },
      BreakStatement(node, _c) {
        if (node.label) {
          node.label.name = labelNames.get(node.label.name);
        }
      },
      ContinueStatement(node, _c) {
        if (node.label) {
          node.label.name = labelNames.get(node.label.name);
        }
      },
    });

    // Finally, the function name, after restoring it.
    fun.id = funId;
    assert(extraInfo.globals.hasOwnProperty(fun.id.name));
    fun.id.name = extraInfo.globals[fun.id.name];
  }
}

function minifyGlobals(ast) {
  // The input is in form
  //
  //   function instantiate(wasmImports, wasmMemory, wasmTable) {
  //      var helper..
  //      function asmFunc(global, env, buffer) {
  //        var memory = env.memory;
  //        var HEAP8 = new global.Int8Array(buffer);
  //
  // We want to minify the interior of instantiate, basically everything but
  // the name instantiate itself, which is used externally to call it.
  //
  // This is *not* a complete minification algorithm. It does not have a full
  // understanding of nested scopes. Instead it assumes the code is fairly
  // simple - as wasm2js output is - and looks at all the minifiable names as
  // a whole. A possible bug here is something like
  //
  //   function instantiate(wasmImports, wasmMemory, wasmTable) {
  //      var x = foo;
  //      function asmFunc(global, env, buffer) {
  //        var foo = 10;
  //
  // Here foo is declared in an inner scope, and the outer use of foo looks
  // to the global scope. The analysis here only thinks something is from the
  // global scope if it is not in any var or function declaration. In practice,
  // the globals used from wasm2js output are things like Int8Array that we
  // don't declare as locals, but we should probably have a fully scope-aware
  // analysis here. FIXME

  // We must run on a singleton instantiate() function as described above.
  assert(
    ast.type === 'Program' &&
      ast.body.length === 1 &&
      ast.body[0].type === 'FunctionDeclaration' &&
      ast.body[0].id.name === 'instantiate',
  );
  const fun = ast.body[0];

  // Swap the function's name away so that we can then minify everything else.
  const funId = fun.id;
  fun.id = null;

  // Find all the declarations.
  const declared = new Set();

  // Some identifiers must be left as they are and not minified.
  const ignore = new Set();

  simpleWalk(fun, {
    FunctionDeclaration(node) {
      if (node.id) {
        declared.add(node.id.name);
      }
      for (const param of node.params) {
        declared.add(param.name);
      }
    },
    FunctionExpression(node) {
      for (const param of node.params) {
        declared.add(param.name);
      }
    },
    VariableDeclaration(node) {
      for (const decl of node.declarations) {
        declared.add(decl.id.name);
      }
    },
    MemberExpression(node) {
      // In  x.a  we must not minify a. However, for  x[a]  we must.
      if (!node.computed) {
        ignore.add(node.property);
      }
    },
  });

  // TODO: find names to avoid, that are not declared (should not happen in
  // wasm2js output)

  // Minify the names.
  let nextMinifiedName = 0;

  function getNewMinifiedName() {
    ensureMinifiedNames(nextMinifiedName);
    return minifiedNames[nextMinifiedName++];
  }

  const minified = new Map();

  function minify(name) {
    if (!minified.has(name)) {
      minified.set(name, getNewMinifiedName());
    }
    assert(minified.get(name));
    return minified.get(name);
  }

  // Start with the declared things in the lowest indices. Things like HEAP8
  // can have very high use counts.
  for (const name of declared) {
    minify(name);
  }

  // Minify all globals in function chunks, i.e. not seen here, but will be in
  // the minifyLocals work on functions.
  for (const name of extraInfo.globals) {
    declared.add(name);
    minify(name);
  }

  // Replace the names with their minified versions.
  simpleWalk(fun, {
    Identifier(node) {
      if (declared.has(node.name) && !ignore.has(node)) {
        node.name = minify(node.name);
      }
    },
  });

  // Restore the name
  fun.id = funId;

  // Emit the metadata
  const json = {};
  for (const x of minified.entries()) json[x[0]] = x[1];

  suffix = '// EXTRA_INFO:' + JSON.stringify(json);
}

// Utilities

function reattachComments(ast, commentsMap) {
  const symbols = [];

  // Collect all code symbols
  ast.walk(
    new terser.TreeWalker((node) => {
      if (node.start?.pos) {
        symbols.push(node);
      }
    }),
  );

  // Sort them by ascending line number
  symbols.sort((a, b) => a.start.pos - b.start.pos);

  // Walk through all comments in ascending line number, and match each
  // comment to the appropriate code block.
  let j = 0;
  for (const [pos, comments] of Object.entries(commentsMap)) {
    while (j < symbols.length && symbols[j].start.pos < pos) {
      ++j;
    }
    if (j >= symbols.length) {
      trace('dropping comments: no symbol comes after them');
      break;
    }
    if (symbols[j].start.pos != pos) {
      // This comment must have been associated with a node that still
      // exists in the AST, otherwise to drop it.
      trace('dropping comments: not linked to any remaining AST node');
      continue;
    }
    symbols[j].start.comments_before ??= [];
    for (const comment of comments) {
      trace('reattaching comment');
      symbols[j].start.comments_before.push(
        new terser.AST_Token(
          comment.type == 'Line' ? 'comment1' : 'comment2',
          comment.value,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          '0',
        ),
      );
    }
  }
}

// Main

let suffix = '';

const {
  values: {
    'closure-friendly': closureFriendly,
    'export-es6': exportES6,
    verbose,
    'no-print': noPrint,
    'minify-whitespace': minifyWhitespace,
    outfile,
  },
  positionals: [infile, ...passes],
} = parseArgs({
  options: {
    'closure-friendly': {type: 'boolean'},
    'export-es6': {type: 'boolean'},
    verbose: {type: 'boolean'},
    'no-print': {type: 'boolean'},
    'minify-whitespace': {type: 'boolean'},
    outfile: {type: 'string', short: 'o'},
  },
  allowPositionals: true,
});

function trace(...args) {
  if (verbose) {
    console.warn(...args);
  }
}

// If enabled, output retains parentheses and comments so that the
// output can further be passed out to Closure.

const input = read(infile);
const extraInfoStart = input.lastIndexOf('// EXTRA_INFO:');
let extraInfo = null;
if (extraInfoStart > 0) {
  extraInfo = JSON.parse(input.slice(extraInfoStart + 14));
}
// Collect all JS code comments to this map so that we can retain them in the
// outputted code if --closureFriendly was requested.
const sourceComments = {};
const params = {
  ecmaVersion: 'latest',
  sourceType: exportES6 ? 'module' : 'script',
  allowAwaitOutsideFunction: true,
};
if (closureFriendly) {
  const currentComments = [];
  Object.assign(params, {
    preserveParens: true,
    onToken(token) {
      // Associate comments with the start position of the next token.
      sourceComments[token.start] = currentComments.slice();
      currentComments.length = 0;
    },
    onComment: currentComments,
  });
}

const registry = {
  JSDCE,
  AJSDCE,
  applyImportAndExportNameChanges,
  emitDCEGraph,
  applyDCEGraphRemovals,
  dump,
  littleEndianHeap,
  growableHeap,
  unsignPointers,
  minifyLocals,
  asanify,
  safeHeap,
  minifyGlobals,
};

let ast;
try {
  ast = acorn.parse(input, params);
  for (let pass of passes) {
    const resolvedPass = registry[pass];
    assert(resolvedPass, `unknown optimizer pass: ${pass}`);
    resolvedPass(ast);
  }
} catch (err) {
  if (err.loc) {
    err.message +=
      '\n' +
      `${input.split(acorn.lineBreak)[err.loc.line - 1]}\n` +
      `${' '.repeat(err.loc.column)}^ ${infile}:${err.loc.line}:${err.loc.column + 1}`;
  }
  throw err;
}

if (!noPrint) {
  const terserAst = terser.AST_Node.from_mozilla_ast(ast);

  if (closureFriendly) {
    reattachComments(terserAst, sourceComments);
  }

  let output = terserAst.print_to_string({
    beautify: !minifyWhitespace,
    indent_level: minifyWhitespace ? 0 : 2,
    keep_quoted_props: closureFriendly, // for closure
    wrap_func_args: false, // don't add extra braces
    comments: true, // for closure as well
    shorthand: true, // Use object literal shorthand notation
  });

  output += '\n';
  if (suffix) {
    output += suffix + '\n';
  }

  if (outfile) {
    fs.writeFileSync(outfile, output);
  } else {
    // Simply using `fs.writeFileSync` on `process.stdout` has issues with
    // large amount of data. It can cause:
    //   Error: EAGAIN: resource temporarily unavailable, write
    process.stdout.write(output);
  }
}
