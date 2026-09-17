import {
  compileTemplate,
  parse,
  type CompilerError,
  type CompilerOptions,
  type SFCBlock,
} from "@vue/compiler-sfc"
import { extractor } from "@lingui/cli/api"
import { type ExtractorCtx, type ExtractorType } from "@lingui/conf"
import { type LinguiTemplateTransformOptions } from "@lingui/vue/compiler"
import { compileScriptSetup, type ScriptTarget } from "./compile-script-setup"

export interface VueExtractorConfig {
  reactivityTransform?: boolean
  /**
   * Options of the `@lingui/vue` template transform which compiles
   * `<Trans>`, `<Plural>`, `<Select>`, `<SelectOrdinal>` and `` t`...` ``
   * in `<template>` blocks before extraction.
   *
   * Set to `false` to disable it (only `i18n._()` calls are extracted from templates).
   */
  template?: false | Omit<LinguiTemplateTransformOptions, "descriptorFields">
  /**
   * Options of the Vue template compiler (`whitespace`, `delimiters`...).
   */
  compilerOptions?: TemplateCompilerOptions
}

/**
 * `@vue/compiler-sfc` compiler options accepted by {@link VueExtractorConfig}.
 * `isTS` and `expressionPlugins` are derived from the `lang` of the script blocks.
 */
export type TemplateCompilerOptions = Omit<CompilerOptions, "isTS">

type OnMessageExtracted = Parameters<ExtractorType["extract"]>[2]

type ExtractTarget = ScriptTarget & { isTemplate?: boolean }

const templateScopeRe =
  /(?<![\w$.])(?:_ctx|\$setup|\$props|\$data|\$options)\./g

/**
 * The compiled template prefixes identifiers with their scope
 * (`_ctx.name`, `$setup.name`). Strip it from every identifier of the
 * expression (`_ctx.a + _ctx.b` -> `a + b`) so placeholders read as written.
 */
const normalizeTemplatePlaceholders =
  (onMessageExtracted: OnMessageExtracted): OnMessageExtracted =>
  (message) => {
    if (message.placeholders) {
      message.placeholders = Object.fromEntries(
        Object.entries(message.placeholders).map(([name, source]) => [
          name,
          source.replace(templateScopeRe, ""),
        ]),
      )
    }
    onMessageExtracted(message)
  }

const formatTemplateError = (
  filename: string,
  error: string | CompilerError,
): string => {
  if (typeof error === "string") return error

  const start = error.loc?.start
  const location = start ? `${filename}:${start.line}:${start.column} ` : ""

  return `${location}${error.message}`
}

export const createVueExtractor = (
  config: VueExtractorConfig = {},
): ExtractorType => ({
  match(filename: string) {
    return filename.endsWith(".vue")
  },
  async extract(
    filename: string,
    code: string,
    onMessageExtracted,
    ctx: ExtractorCtx,
  ) {
    const { descriptor } = parse(code, {
      sourceMap: true,
      filename,
      ignoreEmpty: true,
    })

    const isTsBlock = (block: SFCBlock | null) =>
      block?.lang === "ts" || block?.lang === "tsx"
    const isTS =
      isTsBlock(descriptor.script) || isTsBlock(descriptor.scriptSetup)

    const {
      reactivityTransform = false,
      template = {},
      compilerOptions = {},
    } = config

    const compiledScripts = compileScriptSetup(
      descriptor,
      filename,
      reactivityTransform,
    )

    const macroConfig = ctx.linguiConfig?.macro

    // Loaded lazily: `@lingui/vue/compiler` pulls in `@vue/compiler-core`,
    // which is only needed when the template transform is enabled.
    const nodeTransforms =
      template === false || !descriptor.template
        ? []
        : [
            (await import("@lingui/vue/compiler")).linguiTemplateTransform({
              placeholderAttribute: macroConfig?.jsxPlaceholderAttribute,
              placeholderDefaults: macroConfig?.jsxPlaceholderDefaults,
              idPrefixLeader: macroConfig?.idPrefixLeader,
              ...template,
              descriptorFields: "all",
            }),
          ]

    const compiledTemplate =
      descriptor.template &&
      compileTemplate({
        source: descriptor.template.content,
        filename,
        inMap: descriptor.template.map,
        id: filename,
        compilerOptions: {
          ...compilerOptions,
          isTS,
          expressionPlugins: [
            ...(isTS ? (["typescript"] as const) : []),
            ...(compilerOptions.expressionPlugins ?? []).filter(
              (plugin) => plugin !== "typescript",
            ),
          ],
          // The app's own transforms run first, as they would in the build.
          // `@lingui/vue` may resolve a different `@vue/compiler-core` version
          // than the `@vue/compiler-sfc` used here; the AST shapes are compatible.
          nodeTransforms: [
            ...(compilerOptions.nodeTransforms ?? []),
            ...(nodeTransforms as unknown as NonNullable<
              CompilerOptions["nodeTransforms"]
            >),
          ],
        },
      })

    const extractTarget = ({ source, map, isTs, isTemplate }: ExtractTarget) =>
      extractor.extract(
        filename + (isTs ? ".ts" : ""),
        source,
        isTemplate
          ? normalizeTemplatePlaceholders(onMessageExtracted)
          : onMessageExtracted,
        {
          sourceMaps: map,
          ...ctx,
        },
      )

    // Extract the `<script>` blocks first so their messages are reported
    // even when the `<template>` block does not compile.
    await Promise.all(
      compiledScripts
        .filter((target) => target != null && target.source !== "")
        .map(extractTarget),
    )

    if (!compiledTemplate) return

    // Errors reported by the template transform (or by Vue itself) would
    // fail the build, so extraction must not silently succeed on them.
    if (compiledTemplate.errors.length) {
      throw new Error(
        `Cannot compile <template> block:\n` +
          compiledTemplate.errors
            .map((error) => `  ${formatTemplateError(filename, error)}`)
            .join("\n"),
      )
    }

    await extractTarget({
      source: compiledTemplate.code,
      map: compiledTemplate.map,
      isTs: isTS,
      isTemplate: true,
    })
  },
})

/**
 * @deprecated use {@link createVueExtractor} instead
 */
export const vueExtractor = createVueExtractor()
