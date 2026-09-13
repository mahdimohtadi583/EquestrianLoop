import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { verifyCredentials } from './credentials'

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/staff/sign-in' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const email = raw?.email as string | undefined
        const password = raw?.password as string | undefined
        if (!email || !password) return null
        const user = await verifyCredentials(email, password)
        if (!user) return null
        return { id: user.id, email: user.email, name: user.name }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.sub = user.id
      return token
    },
    async session({ session, token }) {
      if (token.sub && session.user) session.user.id = token.sub
      return session
    },
  },
})
