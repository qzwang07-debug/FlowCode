import {
  MAX_BROWSER_VALUE_LENGTH,
  type BrowserCapturedValue,
} from "../../../common/browser";

export interface FieldPrivacyMetadata {
  inputType?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
}

export type SensitiveFieldReason = Extract<
  BrowserCapturedValue,
  { kind: "redacted" }
>["reason"];

function normalized(metadata: FieldPrivacyMetadata): string {
  return [metadata.name, metadata.id, metadata.ariaLabel, metadata.placeholder]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

export function sensitiveFieldReason(
  metadata: FieldPrivacyMetadata,
): SensitiveFieldReason | null {
  const inputType = metadata.inputType?.trim().toLowerCase() ?? "";
  const autocomplete = metadata.autocomplete?.trim().toLowerCase() ?? "";
  const description = normalized(metadata);

  if (inputType === "password") return "password";
  if (/(^|\s)(?:cc-csc|cc-cvc)(\s|$)/.test(autocomplete)) {
    return "security-code";
  }
  if (
    /(^|\s)cc-(?:name|given-name|additional-name|family-name|number|exp|exp-month|exp-year|type)(\s|$)/.test(
      autocomplete,
    )
  ) {
    return "credit-card";
  }
  if (
    /(^|\s)(?:current-password|new-password|one-time-code)(\s|$)/.test(
      autocomplete,
    )
  ) {
    return "sensitive-autocomplete";
  }
  if (/\b(?:cvv|cvc|card security code|security code)\b/.test(description)) {
    return "security-code";
  }
  if (
    /\b(?:credit card|card number|card no|cc number|ccnum|payment card|primary account number|pan number)\b/.test(
      description,
    )
  ) {
    return "credit-card";
  }
  if (
    /\b(?:password|passwd|passcode|secret|api key|access token|auth token)\b/.test(
      description,
    )
  ) {
    return "sensitive-field";
  }
  return null;
}

export function captureFieldValue(
  rawValue: string,
  metadata: FieldPrivacyMetadata,
): BrowserCapturedValue {
  const reason = sensitiveFieldReason(metadata);
  if (reason) {
    return { kind: "redacted", length: rawValue.length, reason };
  }
  return {
    kind: "text",
    value: rawValue.slice(0, MAX_BROWSER_VALUE_LENGTH),
    length: rawValue.length,
    truncated: rawValue.length > MAX_BROWSER_VALUE_LENGTH,
  };
}

export function safeUploadMetadata(files: readonly File[]): {
  fileCount: number;
  extensions: string[];
  mediaTypes: string[];
} {
  const extensions = new Set<string>();
  const mediaTypes = new Set<string>();
  for (const file of files) {
    const dot = file.name.lastIndexOf(".");
    if (dot > 0 && dot < file.name.length - 1) {
      const extension = file.name.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,16}$/.test(extension)) extensions.add(extension);
    }
    if (file.type && file.type.length <= 128) mediaTypes.add(file.type);
  }
  return {
    fileCount: files.length,
    extensions: [...extensions].slice(0, 50),
    mediaTypes: [...mediaTypes].slice(0, 50),
  };
}
