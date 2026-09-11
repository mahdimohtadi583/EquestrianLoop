import 'dotenv/config'

export default {
  datasource: {
    url: process.env.DIRECT_URL,
  },
  migrations: {
    // Prisma 7 reads the seed command from here, not from package.json's
    // `prisma.seed` field (the latter is ignored and prints "No seed command
    // configured" if this block is absent).
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
}
