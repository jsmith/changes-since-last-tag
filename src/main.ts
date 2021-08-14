import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'
import {err, ok, okAsync, Result, ResultAsync} from 'neverthrow'
import minimatch from 'minimatch'

type GitHub = ReturnType<typeof getOctokit>

interface RuntimeError {
  error: unknown
  message: string
}

export function initClient<T extends {githubToken: string}>(
  o: T
): Result<T & {client: GitHub}, RuntimeError> {
  try {
    return ok({
      ...o,
      client: getOctokit(o.githubToken)
    })
  } catch (error) {
    return err({
      message: `There was an error creating GitHub client.`,
      error
    })
  }
}

interface Inputs {
  githubToken: string
  glob: string[]
  tag: string
  repo: string
  owner: string
}

function getInputs(): Result<Inputs, RuntimeError> {
  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) {
    return err({
      error: undefined,
      message: 'No GitHub token found in process.env.GITHUB_TOKEN.'
    })
  }

  let tag = core.getInput('tag')
  if (tag === '') {
    const match = context.ref.match(/^refs\/tags\/(.+)$/)
    if (match === null) {
      return err({
        error: undefined,
        message: `Unable to match tag version number in "${context.ref}". Are you sure this is a tag event?`
      })
    }

    tag = match[1]
  }

  const glob = (core.getInput('glob') || '**').split(',')
  core.info(`Looking for changes in "${glob}"`)

  const repo = core.getInput('repo') || context.repo.repo
  const owner = core.getInput('owner') || context.repo.owner

  return ok({
    githubToken,
    glob,
    tag,
    repo,
    owner
  })
}

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T

type GitHubFile = ThenArg<
  ReturnType<GitHub['repos']['compareCommits']>
>['data']['files'][number]

function getPreviousTag<
  T extends {client: GitHub; tag: string; repo: string; owner: string}
>(
  o: T
): ResultAsync<
  T & {currentTag: string; previousTag: string | undefined},
  RuntimeError
> {
  return ResultAsync.fromPromise(
    o.client.paginate(o.client.repos.listTags, {
      repo: o.repo,
      owner: o.owner
    }),
    error => ({
      error,
      message: `Unable to get tags from ${o.owner}/${o.repo}`
    })
  ).andThen(res => {
    // res looks something like
    // [
    //   {
    //     name: 'v0.3.0',
    //     zipball_url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/zipball/v0.3.0',
    //     tarball_url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/tarball/v0.3.0',
    //     commit: {
    //       sha: '09d21c61653ac696bf86947785181697841709ba',
    //       url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/commits/09d21c61653ac696bf86947785181697841709ba'
    //     },
    //     node_id: 'MDM6UmVmMjk1MDAzNzAxOnJlZnMvdGFncy92MC4zLjA='
    //   },
    //   {
    //     name: 'v0.2.0',
    //     zipball_url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/zipball/v0.2.0',
    //     tarball_url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/tarball/v0.2.0',
    //     commit: {
    //       sha: 'c8d2b32611a6d53601be548ada9923e4333cd4e5',
    //       url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/commits/c8d2b32611a6d53601be548ada9923e4333cd4e5'
    //     },
    //     node_id: 'MDM6UmVmMjk1MDAzNzAxOnJlZnMvdGFncy92MC4yLjA='
    //   },
    //   {
    //     name: 'v0.1.0',
    //     zipball_url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/zipball/v0.1.0',
    //     tarball_url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/tarball/v0.1.0',
    //     commit: {
    //       sha: '150fceadcdabef00ae009745f0d892f983e096b0',
    //       url: 'https://api.github.com/repos/jsmith/changes-since-last-tag-test-repo/commits/150fceadcdabef00ae009745f0d892f983e096b0'
    //     },
    //     node_id: 'MDM6UmVmMjk1MDAzNzAxOnJlZnMvdGFncy92MC4xLjA='
    //   }
    // ]

    // Note reverse is in place
    const index = res.findIndex(tag => tag.name === o.tag)
    if (index === -1) {
      return err({
        error: undefined,
        message: `Unable to find "${o.tag}" in "${res.map(({name}) => name)}"`
      })
    }

    // This could be undefined
    const previousTag = res[index + 1]

    if (previousTag) {
      core.info(`Comparing ${previousTag}...${o.tag}`)
    } else {
      core.info(`${o.tag} is the first tag`)
    }

    return ok({
      ...o,
      currentTag: o.tag,
      previousTag: previousTag?.name
    })
  })
}

function getChangedFiles<
  T extends {
    currentTag: string
    previousTag: string | undefined
    client: GitHub
    repo: string
    owner: string
  }
>(o: T): ResultAsync<T & {changedFiles: GitHubFile[]}, RuntimeError> {
  if (o.previousTag === undefined) return okAsync({...o, changedFiles: []})

  return ResultAsync.fromPromise(
    o.client.paginate(
      o.client.repos.compareCommits.endpoint.merge({
        owner: o.owner,
        repo: o.repo,
        base: o.previousTag,
        head: o.currentTag
      }),
      // This is a bit hacky but it's work
      response => ((response.data as unknown) as {files: GitHubFile[]}).files
    ),
    error => ({
      error,
      message: `There was an error comparing ${o.previousTag}...${o.currentTag} for ${o.owner}/${o.repo}`,
      type: 'error'
    })
  ).map(res => {
    core.info(`Found ${res.length} changed files`)
    return {
      ...o,
      changedFiles: res
    }
  })
}

type SortedFiles = {
  added: string[]
  removed: string[]
  renamed: string[]
  modified: string[]
}

type FileType = keyof SortedFiles

const filesTypes: FileType[] = ['added', 'removed', 'renamed', 'modified']

const isFileType = (status: string): status is FileType =>
  filesTypes.includes((status as unknown) as FileType)

export function sortChangedFiles<T extends {changedFiles: GitHubFile[]}>(
  o: T
): Result<T & {sorted: SortedFiles}, RuntimeError> {
  const sorted: SortedFiles = {
    added: [],
    removed: [],
    renamed: [],
    modified: []
  }
  for (const f of o.changedFiles) {
    if (!isFileType(f.status)) {
      return err({
        error: undefined,
        message: `Unknown file modification status: "${f.status}" from "${f.filename}"`
      })
    }

    sorted[f.status].push(f.filename)
  }

  return ok({
    ...o,
    sorted
  })
}

async function run(): Promise<void> {
  const result = await getInputs()
    .andThen(initClient)
    .asyncAndThen(getPreviousTag)
    .andThen(getChangedFiles)
    .map(o => {
      const previousLength = o.changedFiles.length
      o.changedFiles = o.changedFiles.filter(file => {
        // If there isn't at least one match, filter out the file
        if (!o.glob.some(glob => minimatch(file.filename, glob))) return false
        core.debug(`Matched "${file.filename}"`)
        return true
      })

      core.debug(
        `Filtered out ${
          previousLength - o.changedFiles.length
        } file(s) using given blob`
      )

      core.debug(`There are ${o.changedFiles.length} files remaining`)

      return o
    })
    .andThen(sortChangedFiles)
    .andThen(({sorted, previousTag}) => {
      let anyChanged = false
      const allFiles: string[] = []
      for (const status of filesTypes) {
        anyChanged = anyChanged || sorted[status].length !== 0
        core.setOutput(status, sorted[status].join(', '))
        allFiles.push(...sorted[status])
      }

      core.setOutput('files', allFiles.join(', '))
      core.setOutput('any_changed', anyChanged)
      core.setOutput('first_tag', previousTag === undefined)
      return ok({})
    })

  if (result.isErr()) {
    let error: string | undefined
    try {
      error = JSON.stringify(result.error.error)
    } catch (e) {
      core.error(`Unable to stringify error object: ${result.error}`)
    }

    if (error) {
      core.setFailed(`${result.error.message} (${error})`)
    } else {
      core.setFailed(result.error.message)
    }
  }
}

run()
