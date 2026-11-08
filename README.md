# Bleach vs Naruto 3.0 • Room Online

Bản mod trình duyệt cho hai người chơi Bleach vs Naruto 3.0. Chủ phòng chạy game gốc bằng Ruffle. Người chơi P2 nhận hình ảnh và gửi phím về cùng một phiên game. Mod ưu tiên WebRTC (video 30 fps; điều khiển qua DataChannel) và tự chuyển sang truyền qua máy chủ web nếu kết nối trực tiếp không thành công. Phòng có ID 6 ký tự, dùng tối đa hai người và tự đóng khi P1 rời phòng. Không cần tài khoản.

## Chơi thử trên máy

1. Cài [Node.js 22 LTS trở lên](https://nodejs.org/) và [Git](https://git-scm.com/downloads).
2. Giải nén. Mở Terminal hoặc PowerShell trong thư mục `bvn-room`.
3. Chạy lần lượt:

   ```sh
   npm ci
   npm run setup
   npm start
   ```

4. Mở [http://localhost:3000](http://localhost:3000) bằng Chrome hoặc Edge trên máy tính. Có thể mở cửa sổ ẩn danh thứ hai để thử luồng vào phòng.

Chỉ chạy `npm ci` và `npm run setup` ở lần cài đầu. Lệnh setup tải game 3.0 cùng các tài nguyên đã xác minh, áp dụng bản dịch, rồi cài bản Ruffle tương thích. Lần cài đầu cần Internet. Lần sau chạy `npm start`.

## Đưa lên Internet

Máy chủ Node phục vụ cả trang web lẫn kênh phòng qua WebSocket. Để chơi từ hai mạng khác nhau, hai người cần mở **cùng một URL HTTPS** trỏ tới máy chủ đó.

Ví dụ với [Render Web Service](https://render.com/docs/web-services):

1. Đưa nội dung thư mục `bvn-room` lên một repository Git của bạn. Tạo Web Service từ repository đó, chọn môi trường **Node**.
2. Điền **Build Command** là `npm ci && npm run setup` và **Start Command** là `npm start`. Đặt **Health Check Path** là `/healthz` nếu dùng kiểm tra sức khỏe. Chạy một instance vì phòng hiện lưu trong bộ nhớ.
3. Mở URL HTTPS do dịch vụ cấp trên cả hai máy. Mỗi người chỉ cần trình duyệt, người chơi không phải cài Node hoặc Git nếu có sẵn URL này.

Máy chủ hỗ trợ biến `PORT` (mặc định 3000) và có sẵn `Dockerfile` nếu bạn dùng dịch vụ khác. Nếu có reverse proxy, giữ nguyên Host và cho phép WebSocket ở đường dẫn `/rooms`.

### Tùy chọn TURN cho WebRTC

Chế độ truyền qua máy chủ web có độ trễ cao hơn; phiên bản tối ưu tự điều chỉnh khoảng 10–20 khung hình/giây và giảm độ phân giải JPEG tối đa còn 640 × 480 để tránh ứ đọng dữ liệu. Nếu muốn WebRTC có thêm đường truyền khi kết nối trực tiếp bị chặn, dùng [máy chủ TURN](https://webrtc.org/getting-started/turn-server) có hỗ trợ thông tin đăng nhập có thời hạn (ví dụ coturn với `use-auth-secret`). Đặt các biến bên dưới trên máy chủ web và khởi động lại.

| Biến | Giá trị |
| --- | --- |
| `TURN_URLS` | Một hoặc nhiều URL, cách nhau bằng dấu phẩy. Ví dụ `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp` |
| `TURN_SECRET` | Giá trị `static-auth-secret` dùng chung với máy chủ coturn. Đặt trong phần biến bí mật của dịch vụ. |
| `STUN_URLS` | Tùy chọn. Mặc định dùng `stun:stun.l.google.com:19302`. |

## Bản giảm giật cho Render Singapore

- **Giữ nguyên:** nội dung game 3.0, bản dịch, tạo/vào phòng bằng ID 6 ký tự, bộ phím và URL trên Render khi cập nhật cùng Web Service.
- **Không dùng Socket.IO:** máy chủ dùng gói `ws` cho phòng/chuyển tiếp tín hiệu WebRTC. Không phải thêm `socket.io` hoặc Google Cloud API.
- **Ưu tiên WebRTC trực tiếp:** trước đây P1 chờ tối đa 8 giây rồi thường chuyển sang chuyển tiếp JPEG qua Render; hiện chờ tối đa khoảng 25 giây sau khi tạo offer (P2 tối đa 35 giây), để tránh fallback quá sớm. P2 cũng có thể yêu cầu chuyển sang dự phòng nếu kết nối thất bại.
- **Dữ liệu điều khiển:** kênh trực tiếp ưu tiên độ trễ thấp (unordered/unreliable), gửi trạng thái phím định kỳ 250 ms với số thứ tự để hạn chế kẹt phím. Bấm/thả phím vẫn được gửi ngay lập tức.
- **Giảm tải hình:** WebRTC truyền màn hình P1 tối đa 30 fps thay vì 60 fps, có giới hạn bitrate mục tiêu 1,6 Mbps khi trình duyệt hỗ trợ. Chế độ JPEG dự phòng tự giảm tốc độ truyền nếu mạng bận, không xếp hàng các hình cũ.
- **Hiển thị trong phòng:** `WebRTC trực tiếp` hoặc `Dự phòng qua Render`, kèm RTT đo được bằng WebRTC DataChannel (trực tiếp) hoặc WebSocket tới Render (dự phòng). RTT không bao gồm toàn bộ độ trễ dựng hình và mã hóa video.
- **Nếu luôn ở chế độ dự phòng:** cần kiểm tra NAT/UDP và cân nhắc TURN; thay hosting một mình không bảo đảm hết lag. Nhớ để Web Service một instance và chạy ở Singapore nếu người chơi ở Việt Nam.

> Lưu ý: game Flash chạy và xử lý va chạm **trên trình duyệt của P1**; P2 xem luồng hình ảnh và gửi phím từ xa. Đây không phải hai máy chạy hai bản game đồng bộ rollback. Không thể bảo đảm mượt tuyệt đối trên mọi mạng. Bản mod chỉ mở tối đa 2 người trong một phòng; **chưa** có hệ thống lịch thi đấu, đăng ký 32 người hoặc khán giả.

### Cập nhật Web Service Render đang dùng

1. Giải nén ZIP, vào **thư mục `bvn-room`**. Đưa **các file bên trong** lên repository GitHub cũ, ghi đè `server.mjs`, `public/client.js`, `public/index.html`, `public/style.css`, `README.md`, giữ nguyên các file khác.
2. Vẫn sử dụng Build Command: `npm ci && npm run setup`; Start Command: `npm start` và Health Check Path: `/healthz`.
3. Chờ Render Deploy xong. Mở lại link Render cũ, dùng **Ctrl+Shift+R** hoặc **Cmd+Shift+R** trên Mac để tải mới trang và JavaScript.
4. Dùng hai mạng khác nhau tạo/vào phòng; quan sát mục kết nối. Nếu hiển thị `Dự phòng qua Render`, chất lượng có thể thấp hơn WebRTC trực tiếp.

**Vì game SWF/Ruffle không được đóng gói trong ZIP**, lệnh `npm run setup` vẫn cần Internet để tải tài nguyên. File ZIP ban đầu cũng có cách cài đặt này.

## Cách vào trận

1. P1 bấm **Tạo phòng mới**, sao chép **ID Room** và gửi cho P2.
2. P2 mở cùng trang, nhập ID và bấm **Vào phòng**.
3. Khi đã kết nối, P1 bấm vào màn hình game để lấy tiêu điểm bàn phím, nhấn **J** ở màn hình tiêu đề, chọn **Đấu đơn → Đấu 1v1** bằng **W/S** và **J**. Hai người chọn nhân vật và đấu.

| Hành động | Phím trên mỗi máy |
| --- | --- |
| Di chuyển | W A S D |
| Đánh, nhảy, lướt | J K L |
| Chiêu phụ, tuyệt kỹ, gọi trợ thủ | U I O |

P1 giữ tab game mở trong khi chơi. P2 nhận hình ảnh và điều khiển từ xa. Âm thanh game phát ở máy P1. Khi P2 rời phòng, P1 có thể mời lại bằng cùng mã.

## Nguồn

Game gốc thuộc Jian và 5DPLAY Game Studio. Bước setup tải bản Flash 3.0 từ [BVNPlay](https://bvnplay.online/games/bleach-vs-naruto-3-0/) hoặc [GamesLol](https://en.gameslol.net/bleach-vs-naruto-3-0-1309.html), có [FlashGa.me](https://flashga.me/bleach-vs-naruto-3-0.html) làm nguồn dự phòng cho tài nguyên phụ. Trình chạy Flash là [Ruffle](https://ruffle.rs/), lấy từ commit đã cố định của [dự án DuyOrbit](https://github.com/DuyOrbit/naruto-vs-bleach-online/tree/222ba8f8f08b379509bde031a116108e1211c18a). File ZIP chứa mã phòng đấu, bản dịch, phông chữ và cấu hình chạy.
