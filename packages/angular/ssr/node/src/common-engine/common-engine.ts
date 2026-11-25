/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { ApplicationRef, StaticProvider, Type } from '@angular/core';
import { BootstrapContext } from '@angular/platform-browser';
import { renderApplication, renderModule, ɵSERVER_CONTEXT } from '@angular/platform-server';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { URL } from 'node:url';
import { SSR_REQUEST_LISTENER } from '../../../src/utils/ssr-request';
import { validateUrl } from '../../../src/utils/validation';
import { getAllowedHostsFromEnv } from '../environment-options';
import { attachNodeGlobalErrorHandlers } from '../errors';
import { CommonEngineInlineCriticalCssProcessor } from './inline-css-processor';
import {
  noopRunMethodAndMeasurePerf,
  printPerformanceLogs,
  runMethodAndMeasurePerf,
} from './peformance-profiler';

const SSG_MARKER_REGEXP = /ng-server-context=["']\w*\|?ssg\|?\w*["']/;

/**
 * The time in milliseconds for which a request that ended without a response, such as a request
 * that a page cancelled, stays recorded. It may already have been sent and reach the server later,
 * for example when the server is busy.
 */
const CANCELLED_REQUEST_GRACE_PERIOD = 5_000;

/**
 * @deprecated Use `AngularNodeAppEngine` or `AngularAppEngine` instead.
 * Deprecated since v22.
 */
export interface CommonEngineOptions {
  /** A method that when invoked returns a promise that returns an `ApplicationRef` instance once resolved or an NgModule. */
  bootstrap?: Type<{}> | ((context: BootstrapContext) => Promise<ApplicationRef>);

  /** A set of platform level providers for all requests. */
  providers?: StaticProvider[];

  /** Enable request performance profiling data collection and printing the results in the server console. */
  enablePerformanceProfiler?: boolean;

  /** A set of hostnames that are allowed to access the server. */
  allowedHosts?: readonly string[];
}

/**
 * @deprecated Use `AngularNodeAppEngine` or `AngularAppEngine` instead.
 * Deprecated since v22.
 */
export interface CommonEngineRenderOptions {
  /** A method that when invoked returns a promise that returns an `ApplicationRef` instance once resolved or an NgModule. */
  bootstrap?: Type<{}> | ((context: BootstrapContext) => Promise<ApplicationRef>);

  /** A set of platform level providers for the current request. */
  providers?: StaticProvider[];
  url?: string;
  document?: string;
  documentFilePath?: string;

  /**
   * Reduce render blocking requests by inlining critical CSS.
   * Defaults to true.
   */
  inlineCriticalCss?: boolean;

  /**
   * Base path location of index file.
   * Defaults to the 'documentFilePath' dirname when not provided.
   */
  publicPath?: string;
}

/**
 * A common engine to use to server render an application.
 *
 * @deprecated Use `AngularNodeAppEngine` or `AngularAppEngine` instead.
 * Deprecated since v22.
 */
export class CommonEngine {
  private readonly templateCache = new Map<string, string>();
  private readonly inlineCriticalCssProcessor = new CommonEngineInlineCriticalCssProcessor();
  private readonly pageIsSSG = new Map<string, boolean>();
  private readonly allowedHosts: ReadonlySet<string>;

  /**
   * The URLs that the pages being rendered are requesting from their own host, with the number of
   * these requests in flight and, among them, the number that have not rejected a render yet.
   */
  readonly #requestedUrls = new Map<string, { inFlight: number; pending: number }>();

  constructor(private options?: CommonEngineOptions) {
    this.allowedHosts = new Set(getAllowedHostsFromEnv() ?? this.options?.allowedHosts ?? []);

    attachNodeGlobalErrorHandlers();
  }

  /**
   * Render an HTML document for a specific URL with specified
   * render options
   */
  async render(opts: CommonEngineRenderOptions): Promise<string> {
    const { url } = opts;

    if (url && URL.canParse(url)) {
      const urlObj = new URL(url);
      try {
        validateUrl(urlObj, this.allowedHosts);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `ERROR: ${(error as Error).message}` +
            'Please provide a list of allowed hosts in the "allowedHosts" option in the "CommonEngine" constructor.',
        );

        throw error;
      }
    }

    const enablePerformanceProfiler = this.options?.enablePerformanceProfiler;

    const runMethod = enablePerformanceProfiler
      ? runMethodAndMeasurePerf
      : noopRunMethodAndMeasurePerf;

    let html = await runMethod('Retrieve SSG Page', () => this.retrieveSSGPage(opts));

    if (html === undefined) {
      if (url && this.#consumeRequestedUrl(url)) {
        // A page that is being rendered is requesting this URL from its own host. Rendering it
        // could render a page that requests it again, without bound. Error handlers, such as the
        // default one of Express, answer the request with the `status` and `headers` of this error.
        throw Object.assign(
          new Error(`'${url}' was requested while rendering and is not rendered.`),
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }

      html = await runMethod('Render Page', () => this.renderApplication(opts));

      if (opts.inlineCriticalCss !== false) {
        const content = await runMethod('Inline Critical CSS', () =>
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.inlineCriticalCss(html!, opts),
        );

        html = content;
      }
    }

    if (enablePerformanceProfiler) {
      printPerformanceLogs();
    }

    return html;
  }

  private inlineCriticalCss(html: string, opts: CommonEngineRenderOptions): Promise<string> {
    const outputPath =
      opts.publicPath ?? (opts.documentFilePath ? dirname(opts.documentFilePath) : '');

    return this.inlineCriticalCssProcessor.process(html, outputPath);
  }

  private async retrieveSSGPage(opts: CommonEngineRenderOptions): Promise<string | undefined> {
    const { publicPath, documentFilePath, url } = opts;
    if (!publicPath || !documentFilePath || url === undefined) {
      return undefined;
    }

    const { pathname } = new URL(url, 'resolve://');
    // Do not use `resolve` here as otherwise it can lead to path traversal vulnerability.
    // See: https://portswigger.net/web-security/file-path-traversal
    const pagePath = join(publicPath, pathname, 'index.html');

    const relativePath = relative(publicPath, pagePath);
    const isOutside =
      relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\');
    if (isOutside || isAbsolute(relativePath)) {
      return undefined;
    }

    if (this.pageIsSSG.get(pagePath)) {
      // Serve pre-rendered page.
      return fs.promises.readFile(pagePath, 'utf-8');
    }

    if (pagePath === resolve(documentFilePath) || !(await exists(pagePath))) {
      // View matches with prerender path or file does not exist.
      return undefined;
    }

    // Static file exists.
    const content = await fs.promises.readFile(pagePath, 'utf-8');
    const isSSG = SSG_MARKER_REGEXP.test(content);
    if (isSSG) {
      this.pageIsSSG.set(pagePath, true);

      return content;
    }

    return undefined;
  }

  private async renderApplication(opts: CommonEngineRenderOptions): Promise<string> {
    const moduleOrFactory = this.options?.bootstrap ?? opts.bootstrap;
    if (!moduleOrFactory) {
      throw new Error('A module or bootstrap option must be provided.');
    }

    const extraProviders: StaticProvider[] = [
      { provide: ɵSERVER_CONTEXT, useValue: 'ssr' },
      { provide: SSR_REQUEST_LISTENER, useValue: (url: URL) => this.#recordRequestedUrl(url) },
      ...(opts.providers ?? []),
      ...(this.options?.providers ?? []),
    ];

    let document = opts.document;
    if (!document && opts.documentFilePath) {
      document = await this.getDocument(opts.documentFilePath);
    }

    const commonRenderingOptions = {
      url: opts.url,
      document,
      // Validation is already happened in the render method.
      allowedHosts: ['*'],
    };

    return isBootstrapFn(moduleOrFactory)
      ? renderApplication(moduleOrFactory, {
          platformProviders: extraProviders,
          ...commonRenderingOptions,
        })
      : renderModule(moduleOrFactory, { extraProviders, ...commonRenderingOptions });
  }

  /**
   * Records a URL that a page being rendered is requesting from its own host.
   *
   * @param url - The URL of the request.
   * @returns A function to call once the page no longer waits for the request, with `true` if a
   * response was received, and `false` otherwise.
   */
  #recordRequestedUrl(url: URL): (settled: boolean) => void {
    const key = getRequestedUrlKey(url);
    const record = this.#requestedUrls.get(key) ?? { inFlight: 0, pending: 0 };
    record.inFlight++;
    record.pending++;
    this.#requestedUrls.set(key, record);

    const release = () => {
      record.inFlight--;
      // A request that is no longer in flight cannot reject a render anymore.
      record.pending = Math.min(record.pending, record.inFlight);
      if (record.inFlight === 0) {
        this.#requestedUrls.delete(key);
      }
    };

    return (settled) => {
      if (settled) {
        release();
      } else {
        setTimeout(release, CANCELLED_REQUEST_GRACE_PERIOD).unref?.();
      }
    };
  }

  /**
   * Consumes a request for the given URL that a page being rendered is sending to its own host, if
   * there is one. Each of these requests rejects at most one render of its URL, rather than every
   * render of the URL while it is in flight.
   *
   * @param url - The URL to render.
   * @returns `true` if a request was consumed and the render must be rejected, `false` otherwise.
   */
  #consumeRequestedUrl(url: string): boolean {
    const record =
      this.#requestedUrls.size > 0 && URL.canParse(url)
        ? this.#requestedUrls.get(getRequestedUrlKey(new URL(url)))
        : undefined;
    if (!record?.pending) {
      return false;
    }

    record.pending--;

    return true;
  }

  /** Retrieve the document from the cache or the filesystem */
  private async getDocument(filePath: string): Promise<string> {
    let doc = this.templateCache.get(filePath);

    if (!doc) {
      doc = await fs.promises.readFile(filePath, 'utf-8');
      this.templateCache.set(filePath, doc);
    }

    return doc;
  }
}

async function exists(path: fs.PathLike): Promise<boolean> {
  try {
    await fs.promises.access(path, fs.constants.F_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the key of a URL that a page requests from its own host. It decodes percent-encoded
 * octets one by one, so that malformed escapes do not throw, and drops the characters that `xhr2`
 * escapes or trims, so that the requested URL and the URL that the server rebuilds from the request
 * have the same key.
 *
 * @param url - The URL of a request or of a render.
 * @returns The host name followed by the normalized path and query.
 */
function getRequestedUrlKey({ hostname, pathname, search }: URL): string {
  const pathAndQuery = (pathname + search)
    .replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[\t\n\r]/g, '');

  // Drop the trailing no-break spaces and byte order marks, as UTF-8 octets, which `xhr2` trims.
  // A loop is used because a regular expression anchored at the end is quadratic on long runs.
  let end = pathAndQuery.length;
  while (end > 0) {
    if (pathAndQuery.endsWith('\xC2\xA0', end)) {
      end -= 2;
    } else if (pathAndQuery.endsWith('\xEF\xBB\xBF', end)) {
      end -= 3;
    } else {
      break;
    }
  }

  return hostname + pathAndQuery.slice(0, end);
}

function isBootstrapFn(
  value: unknown,
): value is (context: BootstrapContext) => Promise<ApplicationRef> {
  // We can differentiate between a module and a bootstrap function by reading compiler-generated `ɵmod` static property:
  return typeof value === 'function' && !('ɵmod' in value);
}
