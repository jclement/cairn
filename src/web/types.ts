import type { Session, User } from "../directory";
import type { Env } from "../env";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user?: User;
    session?: Session;
    sessionToken?: string;
  };
};
