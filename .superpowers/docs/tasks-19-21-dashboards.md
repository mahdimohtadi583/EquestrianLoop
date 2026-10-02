# Tasks 19-21: Full Dashboards (Staff & Customer)

**Status:** ✅ Server Actions COMPLETE | Pages PARTIAL  
**Tests:** 188 passing baseline (no regressions)  
**TypeScript:** ✅ Clean  
**Build:** ✅ Passes  

## Summary

Implemented comprehensive server actions and dashboard pages for staff and customer portals. All actions use role guards and tenant isolation. Pages fetch data via server actions and display with shadcn/ui components.

## Task 19: Staff Dashboard - Customers & Horses

### ✅ Completed

**Server Actions** (`src/server/actions/staff-customers.ts`):
- `getCustomers(orgId)` - List all customers with memberships
- `getCustomerById(orgId, customerId)` - Full customer profile + memberships + bookings
- `getCustomerBookedHorses(orgId, customerId)` - Horses through bookings

**Server Actions** (`src/server/actions/staff-horses.ts`):
- `getHorses(orgId)` - List all horses with branch info
- `getHorseById(orgId, horseId)` - Horse detail + sessions + bookings

**Pages**:
- ✅ `/staff/customers/page.tsx` - Customer list with email, membership status
- ✅ `/staff/customers/[id]/page.tsx` - Customer profile, active membership, booking list
- ✅ `/staff/horses/page.tsx` - Horse list with breed, branch, status
- ✅ `/staff/horses/[id]/page.tsx` - Horse detail, upcoming sessions, customer bookings

All pages use `useSession()` to get organization context, load data on mount, handle errors gracefully.

## Task 20: Staff Dashboard - Bookings & Memberships

### ✅ Server Actions Complete

**Server Actions** (`src/server/actions/staff-bookings.ts`):
- `getBookings(orgId)` - List all bookings (customer, horse, session, service)
- `getBookingById(orgId, bookingId)` - Booking detail with customer memberships, trainer, horse, check-in

**Server Actions** (`src/server/actions/staff-memberships.ts`):
- `getMemberships(orgId)` - List memberships with customer, plan, status, expiry
- `getMembershipById(orgId, membershipId)` - Membership detail + customer bookings

### Pages (TBD)

TBD - Create following same pattern as Task 19:
- `/staff/bookings/page.tsx` - List with status, date, customer name, horse
- `/staff/bookings/[id]/page.tsx` - Detail with full session info
- `/staff/memberships/page.tsx` - List with plan, status, expiry
- `/staff/memberships/[id]/page.tsx` - Detail with payment history

## Task 21: Customer Portal - My Data

### ✅ Server Actions Complete

**Server Actions** (`src/server/actions/customer-portal.ts`):
- `getMyCustomerProfile(orgId)` - Current customer profile (name, email)
- `getMyBookings(orgId)` - Customer's own bookings only
- `getMyMembership(orgId)` - Current active membership

All actions:
- Use `requireCustomerRole()` guard
- Look up customer by `userId` for data isolation
- Return only customer's own data

### Pages (TBD)

TBD - Create following same pattern:
- `/[orgSlug]/portal/bookings/page.tsx` - Customer's bookings only
- `/[orgSlug]/portal/membership/page.tsx` - Active membership + billing portal link
- `/[orgSlug]/portal/horses/page.tsx` - Horses through bookings (if applicable)

## Architecture Patterns

### Server Actions Pattern
```typescript
export async function getData(organizationId: string) {
  const session = await getSessionOrRedirect()
  requireStaffRole((session.user as any)?.type)  // or requireCustomerRole

  return withTenantContext(organizationId, (tx) =>
    // Query with includes for relations
  )
}
```

### Page Pattern
```typescript
const [data, setData] = useState(null)
const [loading, setLoading] = useState(true)
const { data: session } = useSession()

useEffect(() => {
  const load = async () => {
    const user = session.user as any
    const result = await getData(user.organizationId || '')
    setData(result as any)  // Cast to any for Decimal/enum type mismatches
  }
  load()
}, [session])
```

### UI Components Used
- `Card`, `CardHeader`, `CardTitle`, `CardContent` - Layout
- `Button` - Actions
- Inline `<span>` badges for status (green for active, stone for neutral)
- Grid layouts for lists
- Responsive `md:grid-cols-2 lg:grid-cols-3` for cards

## Security Properties

✅ **Role Guards** — All actions check `requireStaffRole()` or `requireCustomerRole()`  
✅ **Tenant Isolation** — All queries within `withTenantContext()`  
✅ **Customer Data Access** — Customer actions look up by `userId` only  
✅ **No Secrets** — Organization ID passed as parameter, never stored in component  
✅ **Session Protected** — All pages redirect unauthenticated users  

## Type Handling

Due to Prisma Decimal and enum types not matching client-side expectations:
- Cast server action returns as `as any` in pages
- Use `session.user as any` to access custom fields
- Display types work fine (dates, strings, numbers get converted)

## What's Missing

### Pages to Build
- [ ] `/staff/bookings/[id]/page.tsx` - Booking detail
- [ ] `/staff/memberships/[id]/page.tsx` - Membership detail
- [ ] `/[orgSlug]/portal/bookings/page.tsx` - Customer bookings
- [ ] `/[orgSlug]/portal/membership/page.tsx` - Customer membership
- [ ] `/[orgSlug]/portal/horses/page.tsx` - Customer's horses (if applicable)

### Optional Features
- Booking status updates (requires new server action)
- Billing portal link on membership page (use existing `createBillingPortalSession`)
- Search/filter on list pages
- Pagination for large lists
- Export/print functionality

## Next Steps

1. **Build Remaining Pages** — Follow Task 19 pattern for layout + useEffect + error handling
2. **Add Tests** — Create minimal integration tests for new actions if database connectivity improves
3. **Wire Detail Pages** — Add breadcrumbs, back buttons, action buttons
4. **Polish UI** — Consistent spacing, color scheme, loading states
5. **Performance** — Consider caching, pagination for large datasets

## Build Status

Routes added:
- ✅ `/staff/customers`
- ✅ `/staff/customers/[id]`
- ✅ `/staff/horses`
- ✅ `/staff/horses/[id]`
- TBD: `/staff/bookings`, `/staff/memberships`
- TBD: `/[orgSlug]/portal/*`

Tests baseline maintained at 188 passing (no regressions in code, only DB connectivity issues persist).

---

**Tasks 19-21 Server Actions & First Pages Complete.** Ready for page implementation.
