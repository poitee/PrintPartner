import { useCallback, useState, useEffect } from "react";
import { Copy, Eye, EyeOff, Plus, RotateCw, Trash2, AlertCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

interface ApiKey {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  isActive: boolean;
}

interface NewApiKey extends ApiKey {
  key: string;
}

export default function ApiKeyManagementCard() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewKeyDialog, setShowNewKeyDialog] = useState(false);
  const [newKey, setNewKey] = useState<NewApiKey | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/settings/api-keys");
      if (!response.ok) throw new Error("Failed to load API keys");
      const data = (await response.json()) as { keys: ApiKey[] };
      setKeys(data.keys || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
    const onFocus = () => void loadKeys();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [loadKeys]);

  const handleCreateKey = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/settings/api-keys", { method: "POST" });
      if (!response.ok) throw new Error("Failed to create API key");
      const data = (await response.json()) as NewApiKey;
      setNewKey(data);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setLoading(false);
    }
  };

  const handleRotateKey = async (keyId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/settings/api-keys/${keyId}/regenerate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to rotate API key");
      const data = (await response.json()) as NewApiKey;
      setNewKey(data);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate API key");
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm("Revoke this API key? It will no longer work.")) return;
    try {
      const response = await fetch(`/settings/api-keys/${keyId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to revoke API key");
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key");
    }
  };

  const handleCopyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatDate = (timestamp: string | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleString();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle level={3}>API Keys</CardTitle>
        <CardDescription>
          Generate and manage API keys for automation and integrations
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button
          onClick={handleCreateKey}
          disabled={loading}
          className="w-full"
        >
          <Plus className="mr-2 h-4 w-4" />
          Generate New Key
        </Button>

        {keys.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono">{key.id}</code>
                    <span
                      className={`text-xs px-2 py-1 rounded ${
                        key.isActive
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {key.isActive ? "Active" : "Revoked"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Created: {formatDate(key.createdAt)} • Last used:{" "}
                    {formatDate(key.lastUsedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  {key.isActive && (
                    <>
                      <Button
                        onClick={() => handleRotateKey(key.id)}
                        size="sm"
                        variant="outline"
                        disabled={loading}
                      >
                        <RotateCw className="h-4 w-4" />
                      </Button>
                      <Button
                        onClick={() => handleRevokeKey(key.id)}
                        size="sm"
                        variant="outline"
                        className="text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No API keys yet</p>
        )}

        <Dialog
          open={showNewKeyDialog || !!newKey}
          onOpenChange={(open) => {
            if (!open) setNewKey(null);
            setShowNewKeyDialog(open);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>New API Key</DialogTitle>
            </DialogHeader>
            <div className="text-sm text-muted-foreground mb-4">
              Copy this key and store it securely. You won't be able to see it again.
            </div>
            {newKey && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Key ID</label>
                  <div className="flex gap-2">
                    <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-sm">
                      {newKey.id}
                    </code>
                    <Button
                      onClick={() => {
                        navigator.clipboard.writeText(newKey.id);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Secret Key</label>
                  <div className="flex gap-2">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={newKey.key}
                      readOnly
                      className="font-mono text-sm"
                    />
                    <Button
                      onClick={() => setShowKey(!showKey)}
                      size="sm"
                      variant="outline"
                    >
                      {showKey ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      onClick={handleCopyKey}
                      size="sm"
                      variant="outline"
                    >
                      {copied ? "Copied!" : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  <strong>Save your key now.</strong> You won't be able to see
                  it again. If you lose it, generate a new key and revoke this
                  one.
                </div>

                <Button
                  onClick={() => setNewKey(null)}
                  className="w-full"
                >
                  Done
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
