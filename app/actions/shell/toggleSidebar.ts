"use server";
import { cookies } from "next/headers";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

/**
 * Só persiste a preferência para a PRÓXIMA carga (evita flash de largura
 * errada no SSR de um F5). Não chama `revalidatePath`: o clique já atualiza a
 * largura no cliente via estado local otimista (ver AppShell/Sidebar), e
 * revalidar o layout inteiro por um cookie visual forçava o Next a rebuscar o
 * RSC payload de toda a árvore `/app` a cada clique — issue #recolher-lento.
 */
export async function toggleSidebar(currentlyCollapsed: boolean): Promise<void> {
  const store = await cookies();
  store.set("sidebar_collapsed", currentlyCollapsed ? "0" : "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
