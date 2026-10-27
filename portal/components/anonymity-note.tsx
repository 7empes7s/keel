import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/shell/icons";
import type { AnonymitySetting } from "@/lib/anonymity";

// Shown at the top of a page that names people while "Hide people's names" is on, so a
// code name such as "Person K7Q2" is never mistaken for a real account.
export function AnonymityNote({ setting }: { setting: AnonymitySetting | null }) {
  if (!setting?.enabled) return null;
  return (
    <aside aria-label="People's names are hidden" className="anon-note" data-anonymity="on">
      <span aria-hidden="true" className="anon-note-icon"><Icon name="eye-off" /></span>
      <p>
        <Badge icon={null} tone="low">Names hidden</Badge>{" "}
        People show by code names, like Person K7Q2. A Keel user keeps the same code name on every page; people named by the Microsoft audit log on Changes get code names of their own. Only an admin can show names again, on the People page.
      </p>
    </aside>
  );
}
