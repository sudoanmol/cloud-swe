/**
 * Attachment limits shared by the backend store and the browser composer. This
 * module is intentionally dependency-free so importing it never pulls the
 * database layer into a client bundle.
 */
export const ATTACHMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_MESSAGE_MAX_BYTES = 50 * 1024 * 1024;

export const ATTACHMENT_MESSAGE_MAX_FILES = 10;
