/**
 * ensureTenantForUser NÃO CRIA ORGANIZAÇÃO FANTASMA PARA QUEM FOI CONVIDADO
 * PELO LINK ERRADO — a porta onde o convite pendente (por LINHA em
 * `team_invites`, não por `invite_token` no metadata) é consultado.
 *
 * ## Por que esta cerca existe
 *
 * `decidirConviteDoSignup` (lib/auth/convite-no-signup.ts) só reconhece
 * convite quando `user_metadata.invite_token` está presente — e isso só
 * acontece quando a pessoa passou pelo formulário `/team/accept-invite/<token>`
 * ANTES de criar a conta. Quem foi convidado mas caiu no cadastro genérico
 * (`/login` → "Criar conta") — porque o e-mail do convite nunca saiu
 * (RESEND_API_KEY ausente) ou porque simplesmente clicou no link errado — não
 * tem `invite_token` nenhum no metadata, e `ensureTenantForUser` fazia o que
 * faz com qualquer visitante novo: abria uma organização própria, fantasma,
 * enquanto o convite real ficava "Pendente" para sempre na aba Equipe.
 *
 * Achado real, não hipotético (Iury Castro, 2026-09-21): conta criada, e-mail
 * confirmado, ZERO linhas em `user_organizations`, enquanto havia um convite
 * `manager` esperando pelo mesmo e-mail em `team_invites`.
 *
 * Seguro contra enumeração: este ponto só roda DEPOIS que a posse do e-mail já
 * foi provada (sessão de signup já aberta, ou link de confirmação clicado) —
 * nunca para um visitante anônimo digitando endereços na tela de cadastro.
 *
 * ## Comando
 *
 *     npx vitest run lib/auth/provision.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USUARIO_ID = "11111111-1111-4111-8111-111111111111";
const ORG_DO_CONVITE = "33333333-3333-4333-8333-333333333333";
const CONVITE_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL = "convidado@example.com";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const aplicarConviteMock = vi.fn();
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: aplicarConviteMock }));

/**
 * Dublê do admin client. `linhaDoConvite` é o que `.from("team_invites")`
 * devolve; `null` simula "sem convite pendente" (o caso comum). O caminho de
 * criar organização (quando não há convite) não é exercitado aqui — é coberto
 * pelo cabeçalho original de `ensureTenantForUser`, que este teste não altera.
 */
function adminSemMembership(linhaDoConvite: Record<string, unknown> | null) {
  return {
    from: (tabela: string) => {
      if (tabela === "user_organizations") {
        const c: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "limit"]) c[m] = () => c;
        c.maybeSingle = async () => ({ data: null, error: null }); // sem vínculo vivo
        c.insert = async () => ({ error: null }); // membership da org própria (fallback)
        return c;
      }
      if (tabela === "team_invites") {
        const c: Record<string, unknown> = {};
        for (const m of ["select", "ilike", "is", "gt", "order", "limit"]) c[m] = () => c;
        c.maybeSingle = async () => ({ data: linhaDoConvite, error: null });
        return c;
      }
      // Caminho de fallback (convite recusado, ou sem convite): cria a
      // organização própria de sempre. Não é o foco deste arquivo — só
      // precisa não quebrar o teste que exercita a queda para este ramo.
      if (tabela === "organizations") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: "org-nova", slug: "org-nova" }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no teste: ${tabela}`);
    },
  };
}

async function provisionar(linhaDoConvite: Record<string, unknown> | null) {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  vi.mocked(createAdminClient).mockReturnValue(adminSemMembership(linhaDoConvite) as never);
  const { ensureTenantForUser } = await import("@/lib/auth/provision");
  return ensureTenantForUser({ id: USUARIO_ID, email: EMAIL, user_metadata: {} });
}

describe("ensureTenantForUser consulta team_invites antes de abrir organização nova", () => {
  beforeEach(() => vi.clearAllMocks());

  it("⭐ convite pendente por e-mail vira vínculo na org do convite, NÃO organização nova", async () => {
    aplicarConviteMock.mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });

    const r = await provisionar({
      id: CONVITE_ID,
      organization_id: ORG_DO_CONVITE,
      role: "manager",
      interface_settings: { preset: "completa" },
      invited_by: "44444444-4444-4444-4444-444444444444",
      created_at: "2026-09-21T20:12:12Z",
      expires_at: "2026-09-22T20:12:11Z",
    });

    expect(
      r,
      "achou o convite pendente e mesmo assim abriu organização nova — a organização fantasma que este teste existe para impedir",
    ).toEqual({ provisioned: true, organizationId: ORG_DO_CONVITE });
    expect(aplicarConviteMock).toHaveBeenCalledWith({
      userId: USUARIO_ID,
      payload: expect.objectContaining({
        invite_id: CONVITE_ID,
        organization_id: ORG_DO_CONVITE,
        role: "manager",
        email: EMAIL,
      }),
    });
  });

  it("convite recusado no meio da corrida (revogado bem então) cai para organização própria", async () => {
    aplicarConviteMock.mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });

    const r = await provisionar({
      id: CONVITE_ID,
      organization_id: ORG_DO_CONVITE,
      role: "manager",
      interface_settings: { preset: "completa" },
      invited_by: null,
      created_at: "2026-09-21T20:12:12Z",
      expires_at: "2026-09-22T20:12:11Z",
    });

    // Não trava quem só queria terminar o cadastro: cai para o caminho de
    // sempre. `organizationId` aqui não é o do convite recusado.
    expect(r.organizationId).not.toBe(ORG_DO_CONVITE);
  });

  it("sem convite pendente (o caso comum) não chama aplicarConvite nenhuma vez", async () => {
    await provisionar(null);
    expect(aplicarConviteMock).not.toHaveBeenCalled();
  });
});
