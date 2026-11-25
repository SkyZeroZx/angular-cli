/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// The compiler is needed as tests are in JIT.
/* eslint-disable import/no-unassigned-import */
import '@angular/compiler';
/* eslint-enable import/no-unassigned-import */

import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  Component,
  InjectionToken,
  inject,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { type BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { first, forkJoin, retry } from 'rxjs';
import { provideServerRendering } from '../../src/routes/route-config';
import { CommonEngine } from '../src/common-engine/common-engine';

describe('CommonEngine', () => {
  const document = '<html><head></head><body><app-root></app-root></body></html>';

  /**
   * The URLs that the root component requests while it is rendered, provided at the platform level.
   */
  const PAGE_REQUEST_URLS = new InjectionToken<string[]>('PAGE_REQUEST_URLS');

  /**
   * The timeout in milliseconds of these requests, provided at the platform level.
   */
  const PAGE_REQUEST_TIMEOUT = new InjectionToken<number>('PAGE_REQUEST_TIMEOUT');

  @Component({
    selector: 'app-root',
    template: `{{ response() }}`,
  })
  class AppComponent {
    protected readonly response = signal('');

    constructor() {
      const urls = inject(PAGE_REQUEST_URLS, { optional: true });
      if (urls) {
        const http = inject(HttpClient);
        const timeout = inject(PAGE_REQUEST_TIMEOUT, { optional: true }) ?? undefined;
        // `first()` unsubscribes from each request once its response is received, as router
        // resolvers do, and `forkJoin` cancels the other requests when one of them fails.
        forkJoin(
          urls.map((url) => http.get(url, { responseType: 'text', timeout }).pipe(first())),
        ).subscribe({
          next: (responses) => this.response.set(responses.join()),
          error: () => this.response.set('Request failed'),
        });
      }
    }
  }

  const bootstrap = (context: BootstrapContext) =>
    bootstrapApplication(
      AppComponent,
      {
        providers: [
          provideZonelessChangeDetection(),
          provideServerRendering(),
          provideHttpClient(withInterceptors([(request, next) => next(request).pipe(retry(1))])),
        ],
      },
      context,
    );

  let engine: CommonEngine;

  beforeEach(() => {
    engine = new CommonEngine({ allowedHosts: ['localhost'] });
  });

  it('should reject the render of a URL that a page being rendered is requesting from its own host', async () => {
    const providers = [
      { provide: PAGE_REQUEST_URLS, useValue: [`/api/config('site')?fields=title|logo`] },
    ];
    const errors: unknown[] = [];
    let requestCount = 0;
    spyOn(globalThis, 'fetch').and.callFake(async () => {
      // Stop the loop that renders the page again for each of its own requests.
      if (++requestCount > 5) {
        return new Response(null, { status: 508 });
      }

      // The XHR backend of `@angular/platform-server` percent-encodes `'` and `|` in this URL.
      const url = 'http://localhost/api/config(%27site%27)?fields=title%7Clogo';
      try {
        return new Response(await engine.render({ bootstrap, document, url, providers }));
      } catch (error) {
        errors.push(error);
        const { status, headers } = error as { status: number; headers: Record<string, string> };

        return new Response(null, { status, headers });
      }
    });

    const html = await engine.render({ bootstrap, document, url: 'http://localhost/', providers });
    expect(html).toContain('Request failed');
    // The request and its retry.
    expect(errors).toEqual([
      jasmine.objectContaining({ status: 400, headers: { 'Cache-Control': 'no-store' } }),
      jasmine.objectContaining({ status: 400, headers: { 'Cache-Control': 'no-store' } }),
    ]);
  });

  it('should render a requested URL once the request is complete', async () => {
    spyOn(globalThis, 'fetch').and.callFake(async () => new Response('Config works'));

    const html = await engine.render({
      bootstrap,
      document,
      url: 'http://localhost/',
      providers: [{ provide: PAGE_REQUEST_URLS, useValue: ['/api/config'] }],
    });
    expect(html).toContain('Config works');

    const requestedUrlHtml = await engine.render({
      bootstrap,
      document,
      url: 'http://localhost/api/config',
    });
    expect(requestedUrlHtml).toContain('ng-server-context="ssr"');
  });

  it('should reject a single render of a requested URL for each request in flight', async () => {
    spyOn(globalThis, 'fetch').and.callFake(async () => {
      // Two renders of the requested URL while the request is in flight.
      const render = () =>
        engine.render({ bootstrap, document, url: 'http://localhost/api/config' });
      await expectAsync(render()).toBeRejectedWith(jasmine.objectContaining({ status: 400 }));
      await expectAsync(render()).toBeResolvedTo(
        jasmine.stringContaining('ng-server-context="ssr"'),
      );

      return new Response('Config works');
    });

    const html = await engine.render({
      bootstrap,
      document,
      url: 'http://localhost/',
      providers: [{ provide: PAGE_REQUEST_URLS, useValue: ['/api/config'] }],
    });
    expect(html).toContain('Config works');
  });

  it('should reject the render of a requested URL whose request was cancelled after it was sent', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(async (input, init) => {
      if (input === 'http://localhost/api/user') {
        return new Response(null, { status: 401 });
      }

      // The page cancels this request when the other one fails. As it was already sent, it still
      // reaches the server, some time after it was cancelled.
      await new Promise((resolve) => init?.signal?.addEventListener('abort', resolve));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expectAsync(
        engine.render({ bootstrap, document, url: 'http://localhost/api/config' }),
      ).toBeRejectedWith(jasmine.objectContaining({ status: 400 }));

      return new Response('Config works');
    });

    const html = await engine.render({
      bootstrap,
      document,
      url: 'http://localhost/',
      providers: [{ provide: PAGE_REQUEST_URLS, useValue: ['/api/user', '/api/config'] }],
    });
    expect(html).toContain('Request failed');
    // Wait until the cancelled request has reached the server.
    await Promise.all(fetchSpy.calls.all().map(({ returnValue }) => returnValue));
  });

  it('should keep a request that timed out recorded until the grace period has passed', async () => {
    const graceTimers: (() => void)[] = [];
    const { setTimeout: originalSetTimeout } = globalThis;
    spyOn(globalThis, 'setTimeout').and.callFake(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout !== 5_000) {
        return originalSetTimeout(handler, timeout, ...args);
      }

      graceTimers.push(handler);

      // Fake timers, such as those of `jasmine.clock()`, return a number.
      return 0;
    }) as typeof setTimeout);
    spyOn(globalThis, 'fetch').and.callFake(async (input, init) => {
      const signal = init?.signal;
      await new Promise((resolve) => signal?.addEventListener('abort', resolve));

      throw signal?.reason;
    });

    const html = await engine.render({
      bootstrap,
      document,
      url: 'http://localhost/',
      providers: [
        { provide: PAGE_REQUEST_URLS, useValue: ['/api/config'] },
        { provide: PAGE_REQUEST_TIMEOUT, useValue: 1 },
      ],
    });
    expect(html).toContain('Request failed');
    // The request and its retry timed out without a response, so they may still reach the server.
    expect(graceTimers).toHaveSize(2);

    const render = () => engine.render({ bootstrap, document, url: 'http://localhost/api/config' });
    await expectAsync(render()).toBeRejectedWith(jasmine.objectContaining({ status: 400 }));

    graceTimers.forEach((release) => release());
    await expectAsync(render()).toBeResolvedTo(jasmine.stringContaining('ng-server-context="ssr"'));
  });
});
