#!/usr/bin/env node
/**
 * Release gate for a package that has no build step.
 *
 * The two halves of this plugin are shipped as written — the host half is plain
 * ESM and the browser half is hand-written CJS inside the harness module-loader
 * envelope — so the usual "did the build output match the source?" check has
 * nothing to compare. What can still silently break a release is *metadata*:
 * a package name that no longer matches the module id the browser bundle
 * registers, an `exports` path that points at a file the tarball will not
 * contain, a missing patch file, a peer that pnpm would try to install, or an
 * install-time script (blocked by pnpm ≥ 10, so it would fail for users).
 *
 * This script fails loud on every one of those, and warns on the soft ones.
 *
 * Usage: node scripts/check-manifest.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const warnings = []
const notes = []

/** Record a release-blocking problem. */
function fail(message) {
  problems.push(message)
}

/** Record a soft problem worth seeing at release time. */
function warn(message) {
  warnings.push(message)
}

/** Record a fact worth printing. */
function note(message) {
  notes.push(message)
}

/**
 * Read one repository file.
 * @param relative - path relative to the repository root.
 * @returns the file text, or undefined when it does not exist.
 */
function read(relative) {
  const path = join(ROOT, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Whether one path exists and is non-empty.
 * @param relative - path relative to the repository root.
 * @returns the file size, or undefined when missing or empty.
 */
function sizeOf(relative) {
  const path = join(ROOT, relative)
  if (!existsSync(path)) return undefined
  const size = statSync(path).size
  return size > 0 ? size : undefined
}

const manifestText = read('package.json')
if (manifestText === undefined) {
  console.error('check-manifest: package.json is missing')
  process.exit(1)
}
const manifest = JSON.parse(manifestText)
const name = manifest.name

// --- identity -------------------------------------------------------------

if (typeof name !== 'string' || name.trim() === '') fail('package.json: name must be a non-empty string')
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  fail(`package.json: version "${manifest.version}" is not semver`)
}
if (typeof manifest.license !== 'string' || manifest.license.trim() === '') fail('package.json: license is required')
if (manifest.private === true) fail('package.json: private must not be true for a published plugin')
note(`${name}@${manifest.version} (${manifest.license})`)

// --- host half ------------------------------------------------------------

const hostEntry = manifest.main ?? 'lib/index.js'
const hostSource = read(hostEntry)
if (hostSource === undefined) {
  fail(`${hostEntry} is missing (package.json main)`)
} else {
  for (const [label, pattern] of [
    ['name', /export\s+const\s+name\s*=/],
    ['inject', /export\s+const\s+inject\s*=/],
    ['apply', /export\s+function\s+apply\s*\(/],
  ]) {
    if (!pattern.test(hostSource)) fail(`${hostEntry}: missing the cordis \`${label}\` export`)
  }
  const declaredName = /export\s+const\s+name\s*=\s*'([^']+)'/.exec(hostSource)?.[1]
  if (declaredName !== undefined && declaredName !== name) {
    fail(`${hostEntry}: cordis plugin name "${declaredName}" does not match package name "${name}"`)
  }
}

// --- browser half ---------------------------------------------------------

const clientEntry = typeof manifest.exports?.['./client'] === 'string'
  ? manifest.exports['./client']
  : manifest.exports?.['./client']?.default
if (typeof clientEntry !== 'string') {
  fail('package.json: exports["./client"] must point at the browser bundle')
} else {
  const clientSource = read(clientEntry)
  if (clientSource === undefined) {
    fail(`${clientEntry} is missing (exports["./client"])`)
  } else {
    if (!clientSource.includes('__ModuleLoader__')) {
      fail(`${clientEntry}: missing the window.__ModuleLoader__ envelope the harness loader requires`)
    }
    // The bundle's registered id must be the package name: the client module
    // graph keys rows by package name, and a mismatch fails at load time with
    // "bundle ... loaded without registering <id>".
    const registeredId = /id:\s*'([^']+)'/.exec(clientSource)?.[1]
    if (registeredId !== name) {
      fail(`${clientEntry}: registers module id "${registeredId}" but the package name is "${name}" (they must match)`)
    }
    if (!clientSource.includes('factory:')) fail(`${clientEntry}: envelope is missing the factory`)
    note(`${clientEntry}: ${sizeOf(clientEntry)} bytes, module id ok`)
  }
}

// --- the profile patch layer ---------------------------------------------

const patchEntry = manifest.dsh?.bundle?.patch
if (typeof patchEntry !== 'string') {
  fail('package.json: dsh.bundle.patch is required so `dsh plugin add` mounts the plugin')
} else {
  const patch = read(patchEntry.replace(/^\.\//, ''))
  if (patch === undefined) {
    fail(`${patchEntry} is missing (dsh.bundle.patch)`)
  } else {
    if (!/^-\s*insert:/m.test(patch)) fail(`${patchEntry}: expected a top-level \`- insert:\` list`)
    if (!patch.includes(`name: '${name}'`) && !patch.includes(`name: ${name}`)) {
      fail(`${patchEntry}: the insert row must name this package ("${name}")`)
    }
    note(`${patchEntry}: insert row ok`)
  }
}

// --- browser roster declaration ------------------------------------------

if (manifest.dsh?.client?.platform !== 'web') {
  fail('package.json: dsh.client.platform must be "web" for a browser half to be served')
}
// `inject` names client rows that must arrive before this bundle's factory runs.
// Declaring the conversation UI is the idiomatic choice for a composer seat; the
// field is optional and an unknown name is skipped by the host, not fatal.
const clientInject = manifest.dsh?.client?.inject
if (clientInject !== undefined) {
  if (!Array.isArray(clientInject) || clientInject.some((entry) => typeof entry !== 'string')) {
    fail('package.json: dsh.client.inject must be an array of package names')
  } else {
    note(`dsh.client.inject: ${clientInject.join(', ') || '(empty)'}`)
  }
}
if (manifest.dsh?.client?.external !== undefined) {
  warn('package.json: dsh.client.external names non-inject module requests; this bundle requires only platform seed modules, so it should be omitted')
}

// --- host compatibility declaration --------------------------------------

if (typeof manifest.engines?.dsh !== 'string') {
  warn('package.json: engines.dsh is not declared — the plugin market and directory cannot show a host requirement')
} else {
  note(`engines.dsh: ${manifest.engines.dsh}`)
}

// --- install must stay dependency-free ------------------------------------

const peerNames = Object.keys(manifest.peerDependencies ?? {})
for (const peer of peerNames) {
  if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) {
    fail(`package.json: peer "${peer}" must be marked optional — pnpm auto-installs required peers, and these are provided by the host at runtime`)
  }
}
for (const field of ['dependencies', 'optionalDependencies']) {
  const entries = Object.keys(manifest[field] ?? {})
  if (entries.length > 0) fail(`package.json: ${field} must stay empty (zero-install package): ${entries.join(', ')}`)
}
for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (manifest.scripts?.[script] !== undefined) {
    fail(`package.json: scripts.${script} is blocked by pnpm ≥ 10 and would break installation for users`)
  }
}

// --- shipped files must exist --------------------------------------------

for (const entry of manifest.files ?? []) {
  const target = entry.replace(/\/$/, '')
  if (!existsSync(join(ROOT, target))) fail(`package.json: files entry "${entry}" does not exist`)
}

// --- documents a public repository is expected to carry -------------------

for (const doc of ['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
  if (read(doc) === undefined) warn(`${doc} is missing`)
}

// --- report ---------------------------------------------------------------

for (const line of notes) console.log(`  ok    ${line}`)
for (const line of warnings) console.warn(`  warn  ${line}`)
for (const line of problems) console.error(`  error ${line}`)
console.log(`\ncheck-manifest: ${problems.length} error(s), ${warnings.length} warning(s)`)
process.exit(problems.length === 0 ? 0 : 1)
