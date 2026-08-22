import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { acceptPlanShare, fetchIncomingShares, type IncomingShare } from "@/api/engine";
import { useAuth } from "@/context/AuthContext";
import { useProfileSelection } from "@/context/ProfileContext";
import { buildRoute } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function IncomingSharesCard() {
  const { multiUser } = useAuth();
  const { reloadProfiles, setSelectedProfileId } = useProfileSelection();
  const navigate = useNavigate();
  const [shares, setShares] = useState<IncomingShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!multiUser) return;
    setLoading(true);
    try {
      const res = await fetchIncomingShares();
      setShares(res.shares);
    } catch {
      setShares([]);
    } finally {
      setLoading(false);
    }
  }, [multiUser]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!multiUser) return null;

  if (!loading && shares.length === 0) return null;

  const onAccept = (share: IncomingShare) => {
    setAccepting(share.id);
    void acceptPlanShare(share.token)
      .then(async (result) => {
        toast.success(`Imported "${result.profile_name}"`);
        await reloadProfiles();
        setSelectedProfileId(result.profile_id);
        navigate(buildRoute(result.profile_id));
        await load();
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setAccepting(null));
  };

  return (
    <Card>
      <CardHeader accent>
        <CardTitle className="text-base">Shared builds</CardTitle>
        <CardDescription>
          Builds other users sent you — accept to get your own editable copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {shares.map((share) => (
          <div
            key={share.id}
            className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{share.plan_name}</p>
              <p className="text-xs text-muted-foreground">
                From {share.from_display_name}
                {share.recipient_email ? ` · for ${share.recipient_email}` : ""}
              </p>
            </div>
            <Button
              size="sm"
              disabled={accepting === share.id}
              onClick={() => onAccept(share)}
            >
              {accepting === share.id ? "Importing…" : "Accept copy"}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
