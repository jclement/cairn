import type { Env as CairnEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends CairnEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
      durableNamespaces: "VaultDO";
    }
  }
}
