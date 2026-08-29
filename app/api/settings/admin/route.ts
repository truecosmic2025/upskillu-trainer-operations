import { createAdminGetHandler, createAdminPatchHandler } from "../../../../lib/settings-handlers";

export const GET = createAdminGetHandler();
export const PATCH = createAdminPatchHandler();
