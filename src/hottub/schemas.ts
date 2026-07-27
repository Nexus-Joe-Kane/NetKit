import { z } from "zod";

export const ChannelStatusSchema = z.enum([
  "active",
  "normal",
  "ok",
  "inactive",
  "degraded",
  "maintenance",
  "restricted",
  "error",
  "unknown",
  "testing",
]);

export const NoticeSchema = z.object({
  status: z.string().min(1).max(32),
  message: z.string().min(1).max(160).optional(),
  details: z.string().min(1).max(1000).optional(),
  priority: z.boolean().optional(),
  url: z.string().url().nullable().optional(),
});

export const ChannelOptionChoiceSchema: z.ZodType<ChannelOptionChoice> = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(100),
  description: z.string().max(300).optional(),
  options: z.lazy(() => z.array(ChannelOptionSchema).max(20)).optional(),
});

export const ChannelOptionSchema: z.ZodType<ChannelOption> = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(100),
  systemImage: z.string().max(100).optional(),
  colorName: z.string().max(50).optional(),
  multiSelect: z.boolean().optional(),
  // A range control carries no choices, so an empty list is legitimate.
  options: z.array(ChannelOptionChoiceSchema).max(50),
  // Undocumented but used by the official source to describe non-list
  // controls: `control: "range"` plus min/max/step/ticks. Every value is a
  // string there, and the client decodes it that way.
  properties: z.record(z.string(), z.string().max(2_000)).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export interface ChannelOptionChoice {
  id: string;
  title: string;
  description?: string;
  options?: ChannelOption[];
}

export interface ChannelOption {
  id: string;
  title: string;
  systemImage?: string;
  colorName?: string;
  multiSelect?: boolean;
  options: ChannelOptionChoice[];
  properties?: Record<string, string>;
  value?: string | number | boolean;
}

export const ChannelSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  premium: z.boolean().optional(),
  favicon: z.string().url().optional(),
  image: z.string().url().optional(),
  status: ChannelStatusSchema.optional(),
  categories: z.array(z.string().min(1).max(80)).max(100).optional(),
  tags: z
    .array(
      z.union([
        z.string().min(1).max(80),
        z.object({
          name: z.string().min(1).max(80),
          systemImage: z.string().max(100).optional(),
        }),
      ]),
    )
    .max(30)
    .optional(),
  options: z.array(ChannelOptionSchema).max(20).optional(),
  maintainers: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        avatar: z.string().url().optional(),
        role: z.enum(["maintainer", "upstream"]).optional(),
      }),
    )
    .max(10)
    .optional(),
  nsfw: z.boolean().optional(),
  default: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  groupKey: z.string().max(80).optional(),
  ytdlpCommand: z.string().max(500).optional(),
  cacheDuration: z.number().int().min(0).max(86_400).optional(),
});

export const ChannelGroupSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(100),
  channelIds: z.array(z.string().min(1).max(64)).min(1),
  systemImage: z.string().max(100).optional(),
});

export const ServerStatusSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(160),
  subtitle: z.string().max(300).optional(),
  description: z.string().max(1000).optional(),
  iconUrl: z.string().url().optional(),
  color: z.string().max(32).optional(),
  status: ChannelStatusSchema.optional(),
  notices: z.array(NoticeSchema).max(20).optional(),
  channels: z.array(ChannelSchema).min(1),
  channelGroups: z.array(ChannelGroupSchema).max(10).optional(),
  nsfw: z.boolean().optional(),
  categories: z.array(z.string().min(1).max(80)).max(100).optional(),
  options: z.array(ChannelOptionSchema).max(20).optional(),
  popup: z
    .object({
      id: z.string().min(1).max(100),
      pages: z.array(z.unknown()).max(20),
    })
    .passthrough()
    .nullable()
    .optional(),
  filtersFooter: z.string().max(500).optional(),
});

export const VideoFormatSchema = z.object({
  url: z.string().url(),
  formatId: z.string().max(100).optional(),
  ext: z.string().max(20).optional(),
  protocol: z.string().max(40).optional(),
  httpHeaders: z.record(z.string(), z.string().max(1000)).optional(),
  height: z.number().int().positive().max(16_384).optional(),
  width: z.number().int().positive().max(16_384).optional(),
  resolution: z.string().max(40).optional(),
  format: z.string().max(80).optional(),
  fps: z.number().positive().max(1000).optional(),
  quality: z.union([z.number(), z.string().max(80)]).optional(),
  vcodec: z.string().max(100).optional(),
  acodec: z.string().max(100).optional(),
  tbr: z.number().nonnegative().optional(),
  abr: z.number().nonnegative().optional(),
  vbr: z.number().nonnegative().optional(),
  dynamicRange: z.string().max(40).optional(),
  aspectRatio: z.number().positive().max(10).optional(),
  filesize: z.number().int().nonnegative().optional(),
  language: z.string().max(40).optional(),
  container: z.string().max(40).optional(),
});

export const UploaderProfileSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  normalizedName: z.string().max(200).optional(),
  avatar: z.string().url().nullable().optional(),
  videoCount: z.number().int().nonnegative().optional(),
  totalViews: z.number().int().nonnegative().optional(),
});

export const VideoSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(500),
  url: z.string().url(),
  duration: z.number().int().nonnegative(),
  channel: z.string().min(1).max(64),
  thumb: z.string().url(),
  views: z.number().int().nonnegative().optional(),
  rating: z.number().min(0).max(100).optional(),
  uploader: z.string().max(200).optional(),
  uploaderUrl: z.string().url().optional(),
  uploaderId: z.string().max(200).optional(),
  verified: z.boolean().optional(),
  isVR: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(120)).max(200).optional(),
  categories: z.array(z.string().min(1).max(120)).max(100).optional(),
  uploadedAt: z.string().max(100).optional(),
  preview: z.string().url().optional(),
  formats: z.array(VideoFormatSchema).max(30).optional(),
  aspectRatio: z.number().positive().max(10).optional(),
  uploaderProfile: UploaderProfileSchema.optional(),
  embed: z
    .object({
      source: z.string().url().optional(),
      html: z.string().max(20_000).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .optional(),
  isLive: z.boolean().optional(),
  liveStatus: z.enum(["live", "not_live", "was_live", "post_live"]).optional(),
  availability: z.string().max(50).optional(),
});

export const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  recommendations: z.array(z.string().min(1).max(200)).max(20).optional(),
  error: z.string().max(1000).nullable().optional(),
  message: z.string().max(1000).nullable().optional(),
  // Hot Tub's own types declare this as `Record<string, string>`
  // (@hottubapp/api-core, VideoResult.pageInfo). The iOS client decodes it
  // strictly, so a numeric value fails to decode and the app reports a
  // generic "Server Error" even though the response is otherwise valid and
  // full of usable items. Values must be serialised as strings.
  parameters: z.record(z.string(), z.string()).optional(),
});

export const VideosResponseSchema = z.object({
  pageInfo: PageInfoSchema,
  items: z.array(VideoSchema).max(600),
});

export const UploaderSchema = z.object({
  id: z.union([z.string().min(1).max(200), z.number()]),
  name: z.string().min(1).max(200),
  normalizedName: z.string().max(200).optional(),
  url: z.string().url().nullable().optional(),
  channel: z.string().max(64).nullable().optional(),
  verified: z.boolean().optional(),
  videoCount: z.number().int().nonnegative().optional(),
  totalViews: z.number().int().nonnegative().optional(),
  avatar: z.string().url().nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  bio: z.string().max(5000).nullable().optional(),
  type: z.string().max(50).nullable().optional(),
  videos: z.array(VideoSchema).max(200).nullable().optional(),
  tapes: z.array(z.unknown()).max(200).nullable().optional(),
  playlists: z.array(z.unknown()).max(100).nullable().optional(),
});

const shortString = z.string().trim().min(1).max(200);

export const StatusRequestSchema = z
  .object({
    clientVersion: z.string().trim().max(64).optional(),
  })
  .passthrough();

export const VideosRequestSchema = z
  .object({
    query: z.string().trim().max(200).default(""),
    channel: z.string().trim().min(1).max(64).optional(),
    channels: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    sort: z.string().trim().min(1).max(64).default("relevance"),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(40),
    clientVersion: z.string().trim().max(64).optional(),
    blockedKeywords: z.array(shortString).max(100).default([]),
    blockedUploaders: z.array(shortString).max(100).default([]),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (!value.channel && (!value.channels || value.channels.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Provide channel or channels.",
        path: ["channel"],
      });
    }
  });

export const UploadersRequestSchema = z
  .object({
    uploaderId: shortString.optional(),
    uploaderName: shortString.optional(),
    channel: z.string().trim().min(1).max(64).optional(),
    profileContent: z.boolean().default(false),
    profileVideosSort: z.enum(["uploadDate", "duration", "views", "title"]).optional(),
    profileVideosOrder: z.enum(["asc", "desc"]).optional(),
    query: z.string().trim().max(200).optional(),
  })
  .superRefine((value, context) => {
    if (!value.uploaderId && !value.uploaderName) {
      context.addIssue({
        code: "custom",
        message: "Provide uploaderId or uploaderName.",
        path: ["uploaderId"],
      });
    }
  });

export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelGroup = z.infer<typeof ChannelGroupSchema>;
export type Notice = z.infer<typeof NoticeSchema>;
export type ServerStatus = z.infer<typeof ServerStatusSchema>;
export type Video = z.infer<typeof VideoSchema>;
export type VideosResponse = z.infer<typeof VideosResponseSchema>;
export type Uploader = z.infer<typeof UploaderSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
export type VideosRequest = z.infer<typeof VideosRequestSchema>;
export type UploadersRequest = z.infer<typeof UploadersRequestSchema>;
