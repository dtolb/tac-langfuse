import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@gtmi/strix-react/theme';
import './globals.css';

// Required by Strix — without it the reflow guarantees are void.
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export const metadata: Metadata = {
  title: 'Demo Scaffold',
  description: 'Twilio demo scaffold — customer demo and operator console',
};

// Deliberately a SERVER component with no 'use client'. ThemeProvider carries its own
// 'use client', so it renders straight from here with no wrapper of our own.
// initialTheme is omitted on purpose: dark is the default in both the token layer and JS,
// and passing it would hide a disagreement between them.
//
// Next's generated next/font Geist wiring is dropped — Strix ships Whitney SSm and
// declares --font-sans/--font-display/--font-mono itself.
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-surface-base text-text-primary">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
