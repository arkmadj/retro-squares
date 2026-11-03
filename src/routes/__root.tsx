import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { BUTTON_VARIANTS } from '#/components/common/Button'
import { CRT_INIT_SCRIPT, CrtToggle } from '#/components/CrtToggle'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Retro Squares',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
    ],
  }),
  shellComponent: RootDocument,
  // The page is black, so the router's default black message can't be seen
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="min-h-svh flex flex-col items-center justify-center gap-4 p-4 text-center font-mono text-green-500">
      <h1 className="text-2xl font-bold uppercase tracking-widest">
        Page not found
      </h1>
      <Link to="/" className={`text-sm px-4 py-2 ${BUTTON_VARIANTS.secondary}`}>
        Home
      </Link>
    </main>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The CRT script can set an attribute here before React hydrates
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: CRT_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <CrtToggle />
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
