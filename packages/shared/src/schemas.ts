import { z } from 'zod';
import { ROLES } from './roles.js';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const uuidSchema = z.uuid();

export const idParamSchema = z.object({ id: uuidSchema });

export const facultyInputSchema = z.object({
  name: trimmed(1, 120),
});
export type FacultyInput = z.infer<typeof facultyInputSchema>;

export const buildingInputSchema = z.object({
  name: trimmed(1, 160),
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9._-]+$/, 'code may contain only letters, digits, ".", "_" and "-"'),
  facultyId: uuidSchema.nullable().optional(),
  address: trimmed(0, 240).optional(),
});
export type BuildingInput = z.infer<typeof buildingInputSchema>;

export const buildingPatchSchema = buildingInputSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'at least one field is required' },
);
export type BuildingPatch = z.infer<typeof buildingPatchSchema>;

export const userScopeInputSchema = z.object({
  buildingIds: z.array(uuidSchema).max(1000),
});
export type UserScopeInput = z.infer<typeof userScopeInputSchema>;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const devLoginSchema = z.object({
  email: z.email().max(254),
  displayName: trimmed(1, 120),
  roles: z.array(z.enum(ROLES)).min(1),
});
export type DevLoginInput = z.infer<typeof devLoginSchema>;
