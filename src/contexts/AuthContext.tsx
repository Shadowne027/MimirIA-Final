import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  loadToken,
  login as apiLogin,
  me as apiMe,
  register as apiRegister,
  saveToken,
} from "../lib/api";
import type { AuthUser } from "../lib/api";

interface AuthCtxType {
  user: AuthUser | null;
  initializing: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  register: (username: string, password: string) => Promise<AuthUser>;
  logout: () => void;
}

const AuthCtx = createContext<AuthCtxType>({
  user: null,
  initializing: true,
  login: async () => {
    throw new Error("No implementado");
  },
  register: async () => {
    throw new Error("No implementado");
  },
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  // Restaurar sesión al cargar
  useEffect(() => {
    let alive = true;
    (async () => {
      const token = loadToken();
      if (token) {
        // Solo un 401 del servidor (token vencido o inválido) borra la sesión. Si falla la
        // red o el servidor está arrancando, se reintenta y, en el peor caso, el token se
        // conserva para el próximo intento: antes cualquier error cerraba la sesión.
        for (let attempt = 0; attempt < 3 && alive; attempt++) {
          try {
            const u = await apiMe(token);
            if (alive) setUser(u);
            if (!u) saveToken(null);
            break;
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
      if (alive) setInitializing(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const login = async (username: string, password: string) => {
    const u = await apiLogin(username, password);
    saveToken(u.token);
    setUser(u);
    return u;
  };

  const register = async (username: string, password: string) => {
    const u = await apiRegister(username, password);
    saveToken(u.token);
    setUser(u);
    return u;
  };

  const logout = () => {
    saveToken(null);
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, initializing, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
