'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

/** Keep the current destination visible throughout the shared application shell. */
export function NavLink(props: ComponentProps<typeof Link>) {
  const pathname = usePathname();
  const href = String(props.href);
  const current = pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
  return <Link {...props} aria-current={current ? 'page' : undefined} />;
}
