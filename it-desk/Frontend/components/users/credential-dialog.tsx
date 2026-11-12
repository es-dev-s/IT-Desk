"use client";

import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";

export type Credential = { kind: "created" | "reset"; name: string; email: string; password: string };

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  }
}

/**
 * Shows a one-time password exactly once. The server never returns it again,
 * so the dialog only closes through an explicit "Done".
 */
export function CredentialDialog({ credential, onClose }: { credential: Credential | null; onClose: () => void }) {
  const [copied, setCopied] = useState<"pw" | "all" | null>(null);

  const copy = async (what: "pw" | "all") => {
    if (!credential) return;
    const text =
      what === "pw"
        ? credential.password
        : `IT-Desk sign-in\nURL: ${window.location.origin}/login\nEmail: ${credential.email}\nTemporary password: ${credential.password}\nYou'll be asked to choose your own password when you sign in.`;
    if (await copyText(text)) {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
    } else {
      toast.error("Couldn’t copy", { description: "Select the password and copy it manually." });
    }
  };

  return (
    <Modal
      open={credential !== null}
      onOpenChange={(open) => (open ? null : onClose())}
      title={credential?.kind === "reset" ? "Password reset" : "Account created"}
      description={
        credential
          ? credential.kind === "reset"
            ? `${credential.name} has been signed out everywhere. Share this temporary password with them.`
            : `Share these sign-in details with ${credential.name}.`
          : undefined
      }
      className="max-w-[480px]"
    >
      {credential ? (
        <>
          <ModalBody className="space-y-4">
            <dl className="overflow-hidden rounded-xl border border-line">
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <dt className="text-xs font-medium text-neutral-500">Email</dt>
                <dd className="truncate text-[13px] font-medium text-neutral-900">{credential.email}</dd>
              </div>
              <div className="border-t border-line bg-subtle px-4 py-3">
                <dt className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
                  <KeyRound className="size-3.5" aria-hidden />
                  Temporary password
                </dt>
                <dd className="mt-2 flex items-center gap-2">
                  <code
                    data-testid="temp-password"
                    className="min-w-0 flex-1 select-all break-all rounded-lg border border-line-strong bg-white px-3 py-2 font-mono text-[15px] tracking-[0.04em] text-neutral-900"
                  >
                    {credential.password}
                  </code>
                  <Button size="icon" onClick={() => void copy("pw")} aria-label="Copy password">
                    {copied === "pw" ? <Check className="text-emerald-600" aria-hidden /> : <Copy aria-hidden />}
                  </Button>
                </dd>
              </div>
            </dl>
            <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] leading-5 text-amber-900">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <p>
                This password is shown <strong>once</strong> and isn’t stored anywhere you can see again. They must replace it at their first sign-in.
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => void copy("all")}>
              {copied === "all" ? <Check className="text-emerald-600" aria-hidden /> : <Copy aria-hidden />}
              {copied === "all" ? "Copied" : "Copy sign-in details"}
            </Button>
            <Button variant="dark" onClick={onClose}>
              Done
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
