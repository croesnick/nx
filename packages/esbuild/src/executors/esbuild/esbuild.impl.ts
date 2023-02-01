import 'dotenv/config';
import * as chalk from 'chalk';
import type { ExecutorContext } from '@nrwl/devkit';
import { cacheDir, joinPathFragments, logger } from '@nrwl/devkit';
import {
  copyAssets,
  copyPackageJson,
  CopyPackageJsonOptions,
  printDiagnostics,
  runTypeCheck as _runTypeCheck,
  TypeCheckOptions,
} from '@nrwl/js';
import * as esbuild from 'esbuild';
import { normalizeOptions } from './lib/normalize';

import { EsBuildExecutorOptions } from './schema';
import { removeSync, writeJsonSync } from 'fs-extra';
import { createAsyncIterable } from '@nrwl/devkit/src/utils/async-iterable';
import { buildEsbuildOptions, getOutfile } from './lib/build-esbuild-options';
import { getExtraDependencies } from './lib/get-extra-dependencies';
import { DependentBuildableProjectNode } from '@nrwl/workspace/src/utilities/buildable-libs-utils';
import { join } from 'path';

const CJS_FILE_EXTENSION = '.cjs' as const;

const BUILD_WATCH_FAILED = `[ ${chalk.red(
  'watch'
)} ] build finished with errors (see above), watching for changes...`;
const BUILD_WATCH_SUCCEEDED = `[ ${chalk.green(
  'watch'
)} ] build succeeded, watching for changes...`;

export async function* esbuildExecutor(
  _options: EsBuildExecutorOptions,
  context: ExecutorContext
) {
  const options = normalizeOptions(_options);
  if (options.deleteOutputPath) removeSync(options.outputPath);

  const assetsResult = await copyAssets(options, context);

  const externalDependencies: DependentBuildableProjectNode[] =
    options.external.map((name) => {
      const externalNode = context.projectGraph.externalNodes[`npm:${name}`];
      if (!externalNode)
        throw new Error(
          `Cannot find external dependency ${name}. Check your package.json file.`
        );
      return {
        name,
        outputs: [],
        node: externalNode,
      };
    });

  if (!options.thirdParty) {
    const thirdPartyDependencies = getExtraDependencies(
      context.projectName,
      context.projectGraph
    );
    for (const tpd of thirdPartyDependencies) {
      options.external.push((tpd.node.data as any).packageName);
      externalDependencies.push(tpd);
    }
  }

  const cpjOptions: CopyPackageJsonOptions = {
    ...options,
    // TODO(jack): make types generate with esbuild
    skipTypings: true,
    outputFileExtensionForCjs: CJS_FILE_EXTENSION,
    excludeLibsInPackageJson: !options.thirdParty,
    updateBuildableProjectDepsInPackageJson: externalDependencies.length > 0,
  };

  // If we're bundling third-party packages, then any extra deps from external should be the only deps in package.json
  if (options.thirdParty && externalDependencies.length > 0) {
    cpjOptions.overrideDependencies = externalDependencies;
  } else {
    cpjOptions.extraDependencies = externalDependencies;
  }

  const packageJsonResult = await copyPackageJson(cpjOptions, context);

  if ('context' in esbuild) {
    // 0.17.0+ adds esbuild.context and context.watch()
    if (options.watch) {
      return yield* createAsyncIterable<{ success: boolean; outfile?: string }>(
        async ({ next, done }) => {
          let hasTypeErrors = false;
          const disposeFns = await Promise.all(
            options.format.map(async (format, idx) => {
              const esbuildOptions = buildEsbuildOptions(
                format,
                options,
                context
              );
              const ctx = await esbuild.context({
                ...esbuildOptions,
                plugins: [
                  ...(esbuildOptions.plugins ?? []),
                  // Only emit info on one of the watch processes.
                  idx === 0
                    ? {
                        name: 'nx-watch-plugin',
                        setup(build: esbuild.PluginBuild) {
                          build.onEnd(async (result: esbuild.BuildResult) => {
                            if (!options.skipTypeCheck) {
                              const { errors } = await runTypeCheck(
                                options,
                                context
                              );
                              hasTypeErrors = errors.length > 0;
                            }
                            const success =
                              result.errors.length === 0 && !hasTypeErrors;

                            if (!success) {
                              logger.info(BUILD_WATCH_FAILED);
                            } else {
                              logger.info(BUILD_WATCH_SUCCEEDED);
                            }

                            next({
                              success,
                              // Need to call getOutfile directly in the case of bundle=false and outfile is not set for esbuild.
                              outfile: join(
                                context.root,
                                getOutfile(format, options, context)
                              ),
                            });
                          });
                        },
                      }
                    : null,
                ].filter(Boolean),
              });

              await ctx.watch();
              return () => ctx.dispose();
            })
          );

          registerCleanupCallback(() => {
            assetsResult?.stop();
            packageJsonResult?.stop();
            disposeFns.forEach((fn) => fn());
            done(); // return from async iterable
          });
        }
      );
    } else {
      // Run type-checks first and bail if they don't pass.
      if (!options.skipTypeCheck) {
        const { errors } = await runTypeCheck(options, context);
        if (errors.length > 0) {
          yield { success: false };
          return;
        }
      }

      // Emit a build event for each file format.
      for (let i = 0; i < options.format.length; i++) {
        const format = options.format[i];
        const esbuildOptions = buildEsbuildOptions(format, options, context);
        const buildResult = await esbuild.build(esbuildOptions);

        if (options.metafile) {
          const filename =
            options.format.length === 1
              ? 'meta.json'
              : `meta.${options.format[i]}.json`;
          writeJsonSync(
            joinPathFragments(options.outputPath, filename),
            buildResult.metafile
          );
        }

        yield {
          success: buildResult.errors.length === 0,
          // Need to call getOutfile directly in the case of bundle=false and outfile is not set for esbuild.
          outfile: join(context.root, getOutfile(format, options, context)),
        };
      }
    }
  } else {
    // TODO(jack): Remove in Nx 16
    // < 0.17.0 takes watch as an argument to build()
    if (options.watch) {
      return yield* createAsyncIterable<{ success: boolean; outfile?: string }>(
        async ({ next, done }) => {
          let hasTypeErrors = false;
          const results = await Promise.all(
            options.format.map(async (format, idx) => {
              const esbuildOptions = buildEsbuildOptions(
                format,
                options,
                context
              );
              const watch =
                // Only emit info on one of the watch processes.
                idx === 0
                  ? {
                      onRebuild: async (
                        error: esbuild.BuildFailure,
                        result: esbuild.BuildResult
                      ) => {
                        if (!options.skipTypeCheck) {
                          const { errors } = await runTypeCheck(
                            options,
                            context
                          );
                          hasTypeErrors = errors.length > 0;
                        }
                        const success = !error && !hasTypeErrors;

                        if (!success) {
                          logger.info(BUILD_WATCH_FAILED);
                        } else {
                          logger.info(BUILD_WATCH_SUCCEEDED);
                        }

                        next({
                          success,
                          // Need to call getOutfile directly in the case of bundle=false and outfile is not set for esbuild.
                          outfile: join(
                            context.root,
                            getOutfile(format, options, context)
                          ),
                        });
                      },
                    }
                  : true;
              try {
                const result = await esbuild.build({
                  ...esbuildOptions,
                  watch,
                });

                next({
                  success: true,
                  // Need to call getOutfile directly in the case of bundle=false and outfile is not set for esbuild.
                  outfile: join(
                    context.root,
                    getOutfile(format, options, context)
                  ),
                });

                return result;
              } catch {
                next({ success: false });
              }
            })
          );

          registerCleanupCallback(() => {
            assetsResult?.stop();
            packageJsonResult?.stop();
            results.forEach((r) =>
              // result.stop() is no in esbuild 0.17.0+ but it exists in earlier versions
              r?.['stop']?.()
            );
            done();
          });

          if (!options.skipTypeCheck) {
            const { errors } = await runTypeCheck(options, context);
            hasTypeErrors = errors.length > 0;
          }

          const success =
            results.every((r) => r.errors?.length === 0) && !hasTypeErrors;

          if (!success) {
            logger.info(BUILD_WATCH_FAILED);
          } else {
            logger.info(BUILD_WATCH_SUCCEEDED);
          }
        }
      );
    } else {
      // Run type-checks first and bail if they don't pass.
      if (!options.skipTypeCheck) {
        const { errors } = await runTypeCheck(options, context);
        if (errors.length > 0) {
          yield { success: false };
          return;
        }
      }

      // Emit a build event for each file format.
      for (let i = 0; i < options.format.length; i++) {
        const format = options.format[i];
        const esbuildOptions = buildEsbuildOptions(format, options, context);
        const buildResult = await esbuild.build(esbuildOptions);

        if (options.metafile) {
          const filename =
            options.format.length === 1
              ? 'meta.json'
              : `meta.${options.format[i]}.json`;
          writeJsonSync(
            joinPathFragments(options.outputPath, filename),
            buildResult.metafile
          );
        }

        yield {
          success: buildResult.errors.length === 0,
          // Need to call getOutfile directly in the case of bundle=false and outfile is not set for esbuild.
          outfile: join(context.root, getOutfile(format, options, context)),
        };
      }
    }
  }
}

function getTypeCheckOptions(
  options: EsBuildExecutorOptions,
  context: ExecutorContext
) {
  const { watch, tsConfig, outputPath } = options;

  const typeCheckOptions: TypeCheckOptions = {
    // TODO(jack): Add support for d.ts declaration files -- once the `@nrwl/js:tsc` changes are in we can use the same logic.
    mode: 'noEmit',
    tsConfigPath: tsConfig,
    // outDir: outputPath,
    workspaceRoot: context.root,
    rootDir: context.root,
  };

  if (watch) {
    typeCheckOptions.incremental = true;
    typeCheckOptions.cacheDir = cacheDir;
  }

  return typeCheckOptions;
}

async function runTypeCheck(
  options: EsBuildExecutorOptions,
  context: ExecutorContext
) {
  const { errors, warnings } = await _runTypeCheck(
    getTypeCheckOptions(options, context)
  );
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;

  if (hasErrors || hasWarnings) {
    await printDiagnostics(errors, warnings);
  }

  return { errors, warnings };
}

function registerCleanupCallback(callback: () => void) {
  const wrapped = () => {
    callback();
    process.off('SIGINT', wrapped);
    process.off('SIGTERM', wrapped);
    process.off('exit', wrapped);
  };

  process.on('SIGINT', wrapped);
  process.on('SIGTERM', wrapped);
  process.on('exit', wrapped);
}

export default esbuildExecutor;
