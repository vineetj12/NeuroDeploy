/**
 * Regex-based error classifier.
 * Maps deployment error log text to an ErrorCategory bucket.
 */

export type ErrorCategoryType =
  | "BUILD_ERROR"
  | "TYPE_ERROR"
  | "SYNTAX_ERROR"
  | "MISSING_DEPENDENCY"
  | "MISSING_ENV_VAR"
  | "CONFIG_ERROR"
  | "DEPENDENCY_CONFLICT"
  | "RUNTIME_ERROR"
  | "UNKNOWN";

interface ClassifierRule {
  pattern: RegExp;
  category: ErrorCategoryType;
}

const RULES: ClassifierRule[] = [
  // Type errors (TypeScript / Flow)
  { pattern: /TS\d{4,5}:/i, category: "TYPE_ERROR" },
  { pattern: /type\s+error/i, category: "TYPE_ERROR" },
  { pattern: /cannot\s+find\s+name/i, category: "TYPE_ERROR" },
  { pattern: /is\s+not\s+assignable\s+to\s+type/i, category: "TYPE_ERROR" },
  { pattern: /property\s+['"]?\w+['"]?\s+does\s+not\s+exist/i, category: "TYPE_ERROR" },

  // Syntax errors
  { pattern: /SyntaxError:/i, category: "SYNTAX_ERROR" },
  { pattern: /unexpected\s+token/i, category: "SYNTAX_ERROR" },
  { pattern: /parsing\s+error/i, category: "SYNTAX_ERROR" },

  // Missing dependencies
  { pattern: /cannot\s+find\s+module/i, category: "MISSING_DEPENDENCY" },
  { pattern: /module\s+not\s+found/i, category: "MISSING_DEPENDENCY" },
  { pattern: /could\s+not\s+resolve/i, category: "MISSING_DEPENDENCY" },
  { pattern: /no\s+matching\s+export/i, category: "MISSING_DEPENDENCY" },
  { pattern: /ERR_MODULE_NOT_FOUND/i, category: "MISSING_DEPENDENCY" },

  // Missing environment variables
  { pattern: /env(ironment)?\s*(variable)?\s*(is)?\s*(not\s+set|missing|undefined)/i, category: "MISSING_ENV_VAR" },
  { pattern: /process\.env\.\w+\s+is\s+(undefined|not\s+defined)/i, category: "MISSING_ENV_VAR" },
  { pattern: /DATABASE_URL\s+(is\s+)?(not\s+set|missing)/i, category: "MISSING_ENV_VAR" },

  // Dependency conflicts
  { pattern: /peer\s+dep(endency)?/i, category: "DEPENDENCY_CONFLICT" },
  { pattern: /ERESOLVE/i, category: "DEPENDENCY_CONFLICT" },
  { pattern: /conflicting\s+peer/i, category: "DEPENDENCY_CONFLICT" },
  { pattern: /version\s+conflict/i, category: "DEPENDENCY_CONFLICT" },

  // Config errors
  { pattern: /tsconfig/i, category: "CONFIG_ERROR" },
  { pattern: /next\.config/i, category: "CONFIG_ERROR" },
  { pattern: /vite\.config/i, category: "CONFIG_ERROR" },
  { pattern: /webpack\.config/i, category: "CONFIG_ERROR" },
  { pattern: /eslint.*config/i, category: "CONFIG_ERROR" },
  { pattern: /invalid\s+configuration/i, category: "CONFIG_ERROR" },

  // Runtime errors
  { pattern: /ReferenceError:/i, category: "RUNTIME_ERROR" },
  { pattern: /TypeError:/i, category: "RUNTIME_ERROR" },
  { pattern: /RangeError:/i, category: "RUNTIME_ERROR" },

  // Generic build errors
  { pattern: /build\s+failed/i, category: "BUILD_ERROR" },
  { pattern: /exit\s+code\s+[1-9]/i, category: "BUILD_ERROR" },
  { pattern: /compilation\s+failed/i, category: "BUILD_ERROR" },
  { pattern: /failed\s+to\s+compile/i, category: "BUILD_ERROR" },
  { pattern: /error\s+during\s+build/i, category: "BUILD_ERROR" },

  // ESLint / Linting
  { pattern: /eslint/i, category: "SYNTAX_ERROR" },
  { pattern: /lint\s+failed/i, category: "SYNTAX_ERROR" },

  // Database / Prisma
  { pattern: /prisma/i, category: "CONFIG_ERROR" },
  { pattern: /database\s+connection/i, category: "MISSING_ENV_VAR" },

  // Vercel / Deployment specific
  { pattern: /no\s+output\s+directory/i, category: "CONFIG_ERROR" },
  { pattern: /could\s+not\s+find\s+build\s+script/i, category: "CONFIG_ERROR" },
];

/**
 * Classifies a deployment error message into an error category.
 * Returns the first matching category, or UNKNOWN.
 */
export function classifyError(errorText: string): ErrorCategoryType {
  if (!errorText || errorText.trim() === "") {
    return "UNKNOWN";
  }

  for (const rule of RULES) {
    if (rule.pattern.test(errorText)) {
      return rule.category;
    }
  }

  return "UNKNOWN";
}
