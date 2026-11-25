/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { PlatformLocation } from '@angular/common';
import {
  HttpErrorResponse,
  type HttpEvent,
  HttpEventType,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * The header added to the HTTP requests that an application sends to its own host while it is
 * rendered on the server. The server does not render requests that carry it.
 */
export const SSR_REQUEST_HEADER = 'x-angular-ssr-request';

/**
 * A function called with the URL of each request that the application sends to its own host while
 * it is rendered on the server. The function that it returns is called once the application no
 * longer waits for the request, with `true` if a response was received, and `false` otherwise, such
 * as when the request was cancelled or timed out, in which case it may still reach the server.
 *
 * `CommonEngine` provides it at the platform level, as it does not receive the request headers and
 * recognizes these requests by their URL instead.
 */
export const SSR_REQUEST_LISTENER = new InjectionToken<
  ((url: URL) => (settled: boolean) => void) | null
>(typeof ngDevMode === 'undefined' || ngDevMode ? 'SSR_REQUEST_LISTENER' : '', {
  providedIn: 'platform',
  factory: () => null,
});

/**
 * Adds the {@link SSR_REQUEST_HEADER} header to the requests sent to the host of the page being
 * rendered, and passes their URL to the {@link SSR_REQUEST_LISTENER}. Such a request could
 * otherwise be rendered as a page that sends the same request again, without bound.
 *
 * Host names are compared rather than origins: behind a proxy that terminates TLS, the page is
 * rendered for `http:` while the application may call its public `https:` URL.
 *
 * This interceptor must run after the `@angular/platform-server` interceptor that resolves relative
 * URLs. Requests that are not sent through the `HttpClient` interceptors are not marked.
 */
export const ssrRequestInterceptorFn: HttpInterceptorFn = (request, next) => {
  const { href, hostname } = inject(PlatformLocation);
  if (!URL.canParse(href)) {
    // The URL of the page is unknown, so requests sent to its host cannot be recognized.
    return next(request);
  }

  // URLs that cannot be parsed are marked too: some HTTP clients still send a request for them.
  const url = URL.canParse(request.urlWithParams, href)
    ? new URL(request.urlWithParams, href)
    : undefined;
  if (url && url.hostname !== hostname) {
    return next(request);
  }

  const response = next(request.clone({ setHeaders: { [SSR_REQUEST_HEADER]: '1' } }));
  const listener = url ? inject(SSR_REQUEST_LISTENER) : null;
  if (!url || !listener) {
    return response;
  }

  return new Observable<HttpEvent<unknown>>((subscriber) => {
    // The URL is recorded while the request is in flight, including each time it is sent again.
    const release = listener(url);
    let settled = false;
    subscriber.add(() => release(settled));

    return response.subscribe({
      next: (event) => {
        // A request whose response is received has completed, even if it is then unsubscribed
        // before the response stream ends, as `first()` does.
        settled ||= event.type === HttpEventType.Response;
        subscriber.next(event);
      },
      error: (error: unknown) => {
        // A request that failed without a response, such as one that timed out, may still reach
        // the server.
        settled ||= error instanceof HttpErrorResponse && error.status !== 0;
        subscriber.error(error);
      },
      complete: () => {
        settled = true;
        subscriber.complete();
      },
    });
  });
};

/**
 * Creates the response to a request that the application sent to its own host while it was
 * rendered on the server. The request is not rendered. The response is only meaningful to the
 * render that sent the request, so it does not include the headers configured for the route and
 * must not be stored.
 *
 * @returns A `Response` object with a 400 status code.
 */
export function createSsrRequestResponse(): Response {
  return new Response('Requests sent while rendering on the server are not rendered.', {
    status: 400,
    statusText: 'Bad Request',
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    },
  });
}
