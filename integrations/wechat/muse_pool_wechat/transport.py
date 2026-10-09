"""Compatibility guard for the pinned SDK's expired-send exception bug."""
from wechat_muse_bridge.ilink.client import ILinkClient
from wechat_muse_bridge.ilink.models import ILinkError


class ILinkTransport(ILinkClient):
    def send_message(self, to_user_id, context_token, text):
        try:
            return super().send_message(to_user_id, context_token, text)
        except UnboundLocalError as exc:
            # 0.2.0 references an unset `exc` for ret/errcode -14. Preserve an
            # unconfirmed delivery instead of crashing and replaying the send.
            # Polling still uses the SDK's correct AuthExpired handling.
            raise ILinkError('SDK send result unconfirmed; check login and delivery') from exc
