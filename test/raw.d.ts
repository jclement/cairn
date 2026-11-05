// Vite's ?raw imports (email fixtures).
declare module "*.eml?raw" {
  const text: string;
  export default text;
}

// Vite's ?raw imports (the repo's skills, compared with what the Worker serves).
declare module "*.md?raw" {
  const text: string;
  export default text;
}

// The wrangler config as text (isolation suite checks production vars).
declare module "*.jsonc?raw" {
  const text: string;
  export default text;
}
