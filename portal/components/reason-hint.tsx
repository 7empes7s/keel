import { Icon } from "@/components/shell/icons";
import { optionalReasonMessage } from "@/lib/written-reason";

// Shown under a reason field once something is typed that would not be kept
// ("x", "test", "because"). Empty fields are left to the form's own message.
export function ReasonHint({ value, id }: { value: string; id?: string }) {
  const message = optionalReasonMessage(value);
  if (!message) return null;
  return <small className="reason-hint" id={id} role="status"><Icon name="alert" />{message}</small>;
}
