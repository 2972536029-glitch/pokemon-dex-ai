// ESLint flat config(v3.2,ROADMAP-NEXT T1)。
//
// 挡板哲学:规则选型跟着"真实踩过的坑"走,不追求大全——
// - 服务端 .ts:typescript-eslint recommended(非 type-checked:快,且本仓
//   的类型安全已由 tsc --noEmit 全量把关,lint 不重复做编译器的事);
//   no-explicit-any 关掉:边界处(err: any)是仓内既定取舍。
// - 前端 .jsx:react-hooks 两条规则是重点——rules-of-hooks 违反是真 bug,
//   exhaustive-deps 设 warn(历史代码有既存警告,挡板只拦 error 级)。
// - qa/ 不进 lint 范围:测试脚本是"一次写完跑绿"的产物,挡板管生产代码。
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "server/dist/**", "node_modules/**", "qa/**", "coverage/**"],
  },

  // ---- 服务端 + 数据库脚本:.ts 全量 ----------------------------------------
  {
    files: ["server/src/**/*.ts", "api/**/*.ts", "db/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^$", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ---- 前端:.jsx + .js,react-hooks 规则集 ----------------------------------
  {
    ...reactHooks.configs["recommended-latest"],
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  // ---- 根目录构建配置 --------------------------------------------------------
  {
    files: ["*.config.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
