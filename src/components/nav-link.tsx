'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

/** Keep the current destination visible throughout the shared application shell. */
export function NavLink(props: ComponentProps<typeof Link>) {
  const pathname = usePathname();
  return <Link {...props} aria-current={pathname === props.href ? 'page' : undefined} />;
}
