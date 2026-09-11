export const PERMISSIONS = [
  'customers.manage',
  'horses.manage',
  'staff.manage',
  'services.manage',
  'bookings.manage',
  'sessions.manage',
  'checkins.manage',
  'loyalty.manage',
  'rewards.manage',
  'memberships.manage',
  'billing.manage',
  'reports.view',
  'settings.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  OWNER: [...PERMISSIONS],
  ADMIN: [...PERMISSIONS].filter((p) => p !== 'billing.manage'),
  MANAGER: [
    'customers.manage', 'horses.manage', 'services.manage', 'bookings.manage',
    'sessions.manage', 'checkins.manage', 'loyalty.manage', 'rewards.manage',
    'memberships.manage', 'reports.view',
  ],
  TRAINER: ['sessions.manage', 'checkins.manage'],
  FRONT_DESK: ['customers.manage', 'bookings.manage', 'checkins.manage'],
}
