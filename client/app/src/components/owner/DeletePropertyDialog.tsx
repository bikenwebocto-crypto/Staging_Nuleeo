import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ui/components/ui/alert-dialog";
import { Input } from "@ui/components/ui/input";
import { useState } from "react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";

interface DeletePropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyId: string;
  propertyAddress: string;
}

export function DeletePropertyDialog({
  open,
  onOpenChange,
  propertyId,
  propertyAddress,
}: DeletePropertyDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const handleDelete = async () => {
    if (confirmText !== "DELETE") {
      setError(true);
      return;
    }
    try {
      setIsDeleting(true);
      await apiRequest("DELETE", `/api/properties/${propertyId}`);
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/properties"] });
      toast({
        title: "Property deleted",
        description: `${propertyAddress} has been removed from your portfolio.`,
      });
      onOpenChange(false);
      setConfirmText("");
      setError(false);
      navigate("/properties");
    } catch (err: any) {
      toast({
        title: "Could not delete property",
        description: err?.message ?? "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Property?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{propertyAddress}</strong>?
            <br />
            <br />
            This permanently removes the property and any vacant units. This cannot be undone.
            <br />
            <br />
            Type <strong>DELETE</strong> below to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-2">
          <Input
            value={confirmText}
            onChange={(e) => {
              setConfirmText(e.target.value);
              setError(false);
            }}
            placeholder="Type DELETE to confirm"
            className={error ? "border-red-500 focus-visible:ring-red-500" : ""}
          />
          {error && (
            <p className="text-xs text-red-500 mt-1">Please type DELETE exactly to proceed.</p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              setConfirmText("");
              setError(false);
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isDeleting}
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            className="bg-red-600 hover:bg-red-700"
          >
            {isDeleting ? "Deleting…" : "Delete Property"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
