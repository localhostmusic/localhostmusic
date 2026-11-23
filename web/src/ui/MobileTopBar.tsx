import type { ViewName } from "./Sidebar";
import { MyAvatar } from "./MyAvatar";
import { NotificationsBell } from "./NotificationsBell";

// Top app bar for phones. Tapping the account avatar opens the Account page.
export function MobileTopBar({ title, username, onOpenAccount }: {
  title: string;
  username: string;
  onOpenAccount: (v: ViewName) => void;
}) {
  return (
    <header className="mobile-top">
      <button className="mtop-avatar-btn" onClick={() => onOpenAccount("account")} aria-label="Account">
        <MyAvatar username={username} size={34} />
      </button>
      <span className="mtop-title">{title}</span>
      <NotificationsBell align="right" />
    </header>
  );
}
