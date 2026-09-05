export const MAX_SOURCE_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_ASSISTANT_ACTION_BODY_BYTES = 384 * 1024 * 1024;
export const MAX_KIT_BUNDLE_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_PRINT_FILE_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_THUMBNAIL_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_MULTIPART_FIELD_BYTES = 64 * 1024;

export const SOURCE_UPLOAD_TOO_LARGE_DETAIL =
  `Uploaded source exceeds the ${MAX_SOURCE_UPLOAD_BYTES / 1024 / 1024} MiB upload limit`;
export const KIT_BUNDLE_UPLOAD_TOO_LARGE_DETAIL =
  `Kit bundle exceeds the ${MAX_KIT_BUNDLE_UPLOAD_BYTES / 1024 / 1024} MiB upload limit`;
export const PRINT_FILE_UPLOAD_TOO_LARGE_DETAIL =
  `Print file exceeds the ${MAX_PRINT_FILE_UPLOAD_BYTES / 1024 / 1024} MiB upload limit`;
export const THUMBNAIL_UPLOAD_TOO_LARGE_DETAIL =
  `Thumbnail exceeds the ${MAX_THUMBNAIL_UPLOAD_BYTES / 1024 / 1024} MiB upload limit`;
export const BACKUP_UPLOAD_TOO_LARGE_DETAIL =
  `Backup archive exceeds the ${MAX_BACKUP_UPLOAD_BYTES / 1024 / 1024 / 1024} GiB upload limit`;
