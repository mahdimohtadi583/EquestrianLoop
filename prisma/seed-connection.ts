// Side-effect-only module. It MUST be imported by prisma/seed.ts *before*
// `../src/db/raw-client`, because raw-client resolves its connection string at
// module-load time and cannot be re-pointed afterwards. TypeScript's CommonJS
// emit preserves import order, so the bare `import './seed-connection'` above
// the raw-client import in seed.ts is what gives this file its effect.
//
// Why it is needed: Task 9 Part A moved DATABASE_URL onto `app_runtime`, a
// role with NOBYPASSRLS that is not the table owner. The seed writes the
// global `Permission` catalogue and system `Role`/`RolePermission` rows with
// no tenant context — writes the deny-by-default Permission policy and the
// tenant_isolation policies correctly refuse to `app_runtime`. Seeding is an
// owner-level, migration-time operation here, so it runs on DIRECT_URL, the
// connection string this architecture already reserves for `postgres`. No new
// credential is introduced.
import { useOwnerConnectionForSeed } from '../src/db/env'

useOwnerConnectionForSeed()
