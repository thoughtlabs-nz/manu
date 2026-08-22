/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as captures from "../captures.js";
import type * as detections from "../detections.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as llmUsage from "../llmUsage.js";
import type * as maintenance from "../maintenance.js";
import type * as snapshots from "../snapshots.js";
import type * as species from "../species.js";
import type * as testUpload from "../testUpload.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  captures: typeof captures;
  detections: typeof detections;
  devices: typeof devices;
  http: typeof http;
  llmUsage: typeof llmUsage;
  maintenance: typeof maintenance;
  snapshots: typeof snapshots;
  species: typeof species;
  testUpload: typeof testUpload;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
