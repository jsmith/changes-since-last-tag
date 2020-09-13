import * as process from 'process'
import * as cp from 'child_process'
import * as path from 'path'

// See https://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}

const runAndExpect = (
  tag: string,
  changed: {
    removed?: string[]
    added?: string[]
    renamed?: string[]
    modified?: string[]
  },
  firstTag: boolean,
  glob?: string
): void => {
  const ip = path.join(__dirname, '..', 'lib', 'main.js')
  const options: cp.ExecSyncOptions = {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'jsmith/changes-since-last-tag-test-repo',
      GITHUB_REF: `refs/tags/${tag}`,
      INPUT_GLOB: glob
    }
  }

  let output
  try {
    output = cp.execSync(`node ${ip}`, options).toString()
  } catch (e) {
    // Ensure that the output is actually printed
    // eslint-disable-next-line no-console
    console.error(e.stdout.toString())
    // eslint-disable-next-line no-console
    console.error(e.stderr.toString())
    throw e
  }
  const expected = Object.entries(changed).map(
    ([key, files]) => `::set-output name=${key}::${(files ?? []).join(', ')}`
  )

  const anyChanged = Object.values(changed).some(
    files => files && files.length > 0
  )
  expected.push(`::set-output name=any_changed::${anyChanged}`)
  expected.push(`::set-output name=first_tag::${firstTag}`)

  const allFiles: string[] = []
  for (const items of Object.values(changed)) allFiles.push(...(items ?? []))
  expected.push(`::set-output name=files::${allFiles.join(', ')}`)

  for (const line of expected) {
    if (!output.match(new RegExp(escapeRegExp(line)))) {
      throw Error(
        `Expected "${expected}" in output using options. See output below.\n${output}`
      )
    }
  }
}

// shows how the runner will run a javascript action with env / stdout protocol
test('test runs', () => {
  runAndExpect('v0.1.0', {}, true)
  runAndExpect('v0.2.0', {added: ['src/b.txt']}, false)
  runAndExpect('v0.2.0', {added: ['src/b.txt']}, false, 'other/**,src/**')
  runAndExpect('v0.3.0', {modified: ['a.txt']}, false)
  runAndExpect('v0.3.0', {}, false, 'src/**')
  runAndExpect('v0.4.0', {removed: ['src/b.txt']}, false)
  runAndExpect('v0.4.0', {removed: ['src/b.txt']}, false, '**/*.txt')
  runAndExpect('v0.4.0', {}, false, '*.py,*.js')
  runAndExpect('v0.5.0', {renamed: ['b.txt']}, false)
})
