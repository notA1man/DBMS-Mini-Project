import type { NextAuthConfig } from 'next-auth';

export default {
  providers: [],
  pages: { signIn: '/login' },
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  callbacks: {
    jwt({ token, user }) {
      if (user) { token.userId=user.id; token.role=user.role; }
      return token;
    },
    session({ session, token }) {
      session.user.id=String(token.userId ?? '');
      session.user.role=token.role as string;
      return session;
    },
  },
} satisfies NextAuthConfig;
