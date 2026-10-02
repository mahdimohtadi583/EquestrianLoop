import NextAuth from 'next-auth'

export const { auth } = NextAuth({
  providers: [],
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user
    },
  },
})
