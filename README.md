# Bleach vs Naruto 3.0 tiếng Việt · Room Online

Tạo phòng, gửi ID Room 6 ký tự và chơi 1v1 trên hai trình duyệt. Chế độ mặc định chạy game trên máy P1. Có thể bật chế độ máy chạy trận riêng để P1 và P2 đều nhận hình và gửi phím tới cùng một phiên game trên máy thứ ba.

## Chạy trên máy tính

Cài Node.js 22 trở lên và Git. Giải nén ZIP, mở Terminal hoặc PowerShell trong thư mục `bvn-room` rồi chạy:

```sh
npm ci
npm run setup
npm start
```

Mở [http://localhost:3000](http://localhost:3000) bằng Chrome hoặc Edge. Lần đầu, `npm run setup` tải 293 tệp theo mã kiểm tra SHA-256, áp dụng bản Việt hóa và cài bản Ruffle đã ghim. Cần Internet khi lấy tài nguyên lần đầu. Các lần sau chỉ cần `npm start`.

- **Đấu máy**. Tạo phòng ở chế độ **P1 chạy game** và chọn **Đấu máy** trong game. Khi chưa có người thứ hai, game chạy tại chỗ và chưa truyền hình.
- **Đấu 1v1**. P1 chọn **P1 chạy game**, tạo phòng, gửi mã cho P2. P2 mở cùng URL và nhập mã. P1 chọn **Đấu đơn → Đấu 1v1** trong game. Hai bên dùng WASD và J/K/L/U/I/O trên máy mình. P1 bấm vào game trước khi dùng phím.
- **Đấu lại khi lỗi**. Bấm **Khởi động lại trận** và xác nhận. Cùng ID Room, cả hai trở về menu game với phiên mới. Nếu chỉ mất hình, mở **Chẩn đoán trận đấu → Kết nối lại hình** để nối lại luồng và giữ engine đang chạy.
- Khi mất kết nối với dịch vụ phòng, ghế được giữ tối đa 45 giây từ lúc máy chủ nhận biết kết nối đã đóng. Trang tự thử kết nối lại và có thể giữ ghế khi tải lại đúng tab. Nếu P1 tải lại trang ở chế độ **P1 chạy game**, game bắt đầu lại do engine cũ nằm trong tab đó. Nếu worker vẫn chạy, tải lại trang người chơi ở chế độ worker giữ phiên engine. Sau khi tab hoặc worker chạy game thực sự dừng, khởi động lại sẽ trở về menu.
- Khi dùng **P1 chạy game**, chọn **Ưu tiên độ mượt** trên máy P1 để giảm giới hạn bitrate và độ phân giải truyền. **Cân bằng** là mặc định. Tùy chọn này chỉ tác động tới hình truyền.
- Nhạc và hiệu ứng chạy trên máy chứa engine. P1 có nút tắt tiếng trong chế độ mặc định. Các luồng WebRTC và JPEG trong gói này truyền hình, vì vậy người xem từ xa chưa nghe âm thanh từ game.

## Cập nhật Render Singapore

1. Đưa **nội dung bên trong thư mục `bvn-room`** lên repository GitHub đang dùng. Thêm các tệp mới trong `public/` cùng với các tệp đã cập nhật. Giữ các tệp ẩn cấu hình nếu repository đang dùng chúng. Không cần tải lên ZIP, `node_modules`, hoặc tài nguyên sinh ra sau setup.
2. Trong cùng Render Web Service, giữ vùng **Singapore** nếu đây là cấu hình hiện tại, và dùng một instance vì phòng được lưu trong bộ nhớ. Kiểm tra các giá trị bên dưới và triển khai commit mới.
3. Hai người dùng chung URL HTTPS của Web Service. Nếu dùng reverse proxy riêng, bật WebSocket và giữ Host cho cả `/rooms` và `/frames`.

| Mục | Giá trị |
| --- | --- |
| Build Command | `npm ci && npm run setup` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Cổng | `process.env.PORT`, mặc định 3000 khi chạy cục bộ |

Để quay lại bản trước, triển khai lại commit GitHub trước khi cập nhật hoặc khôi phục nội dung từ ZIP gốc rồi triển khai lại. Một lần khởi động lại dịch vụ sẽ làm mất phòng đang lưu trong bộ nhớ.

## Bật máy chạy trận riêng

Máy chạy trận là một tiến trình Chrome hoặc Edge riêng. Có thể thử trên máy hiện tại bằng một cửa sổ riêng, hoặc chạy trên một máy thứ ba có sẵn. Render vẫn quản lý phòng, xác thực và chuyển tiếp tín hiệu. Một worker xử lý một trận tại một thời điểm. WebRTC được thử độc lập cho từng ghế, với JPEG qua Render làm đường dự phòng từ worker.

1. Tạo một khóa ngẫu nhiên. Chạy lệnh sau ở terminal riêng và giữ kết quả kín.

   ```sh
   node -p "require('node:crypto').randomBytes(32).toString('hex')"
   ```

2. Đặt khóa vào biến môi trường bí mật `ROOM_WORKER_SECRET` trên Render rồi triển khai lại. Nếu thử cục bộ, đặt biến cùng tên trước khi chạy `npm start`. Ví dụ Bash `export ROOM_WORKER_SECRET` sau khi đã gán giá trị, hoặc PowerShell `$env:ROOM_WORKER_SECRET = Read-Host 'Khóa worker'`. Chế độ mặc định vẫn chạy khi biến này để trống.
3. Trên **máy chạy trận**, mở trang `/worker.html` trên cùng URL của dịch vụ, ví dụ [http://localhost:3000/worker.html](http://localhost:3000/worker.html) khi chạy tại chỗ. Nhập khóa ở đó và bấm **Kết nối**. Khi thấy **Đã kết nối. Đang chờ phòng**, để tab đó ở cửa sổ hoạt động và giữ máy thức. Người chơi chỉ mở trang chính.
4. P1 chọn **Máy chạy trận riêng** rồi tạo phòng. P2 vào bằng ID Room. P1 dùng WASD và J để chọn **Đấu đơn → Đấu 1v1** trên hình nhận được. Cả hai gửi phím về worker theo ghế của mình.
5. Nếu worker ngắt, mở lại trang worker và kết nối. Từ phòng đã tạo, bấm **Thử lại máy chạy trận** khi máy đã sẵn sàng. Phòng giữ chế độ worker. Để tắt worker, bấm **Ngắt kết nối** trên máy đó. Để vô hiệu hóa đăng ký worker trên dịch vụ, xóa `ROOM_WORKER_SECRET` và triển khai lại.

WebRTC của worker thử phát tối đa 30 FPS với khung dựng khoảng 800 × 600 khi cửa sổ đủ rộng. JPEG dùng khung tối đa 640 × 480. Đây là giới hạn cấu hình. FPS thực và độ trễ phụ thuộc máy chạy trận, kết nối của từng ghế và phương thức truyền.

## Biến cấu hình

| Biến | Công dụng |
| --- | --- |
| `PORT` | Cổng HTTP. Dịch vụ lắng nghe trên `0.0.0.0`. |
| `ROOM_WORKER_SECRET` | Khóa worker tùy chọn, tối thiểu 32 byte. Đặt trong môi trường của dịch vụ và nhập tại trang worker. |
| `STUN_URLS` | Danh sách URL STUN, cách nhau bằng dấu phẩy. Mặc định `stun:stun.l.google.com:19302`. |
| `TURN_URLS` | Danh sách URL TURN tùy chọn, cách nhau bằng dấu phẩy. |
| `TURN_SECRET` | Khóa xác thực dùng chung với TURN hỗ trợ thông tin đăng nhập có thời hạn. Bắt buộc nếu đặt `TURN_URLS`. |
| `BVN_ASSET_DIR` | Thư mục tùy chọn chứa các tài nguyên gốc đúng mã kiểm tra cho bước setup. Setup vẫn lấy bản Ruffle đã ghim. |

Xem `.env.example` để biết tên biến. Node đọc biến được truyền từ môi trường. Khi muốn đọc một tệp môi trường cục bộ, có thể chạy `node --env-file=.env server.mjs` sau khi tạo tệp `.env`. Giữ khóa worker và khóa TURN ngoài repository.

## Chẩn đoán và tổ chức đấu

- Mở **Chẩn đoán trận đấu** trong phòng để xem FPS luồng, kích thước hình và tình trạng nhận khung. RTT trực tiếp đo trên kênh WebRTC. RTT qua Render đo đường tới dịch vụ phòng. Độ trễ từ nhấn phím đến hình là phép đo riêng.
- **Nghi bị treo** là cảnh báo khi khung đã từng thay đổi, sau đó giữ nguyên qua nhiều lần thử điều khiển. **Luồng chưa có khung** là tín hiệu từ đường hình. **Ruffle tạm dừng** phản ánh trạng thái phát của trình giả lập. Một số menu tĩnh và trạng thái pause bên trong SWF có thể giống nhau ở cấp độ khung hình.
- Bấm **Tải log chẩn đoán** để lấy các sự kiện gần nhất. Khi gửi báo lỗi, ghi thêm tên hai nhân vật, bản đồ, phím hoặc combo, đang đấu máy hay online, nhạc có dừng không và thao tác đã thử. Có thể xem Console của trình duyệt để lấy lỗi chi tiết từ Ruffle, và xem log Render để kiểm tra dịch vụ phòng.
- Đấu loại trực tiếp 32 người có 31 trận khi không có trận tranh hạng ba. Tổ chức từng trận bằng mã phòng riêng, mỗi phòng hai ghế. Lịch thi đấu và kết quả quản lý bên ngoài game.
- Kiểm tra giao thức tại chỗ sau `npm ci` bằng `node --test tests/rooms.test.mjs`. Kết quả kiểm thử và các giới hạn còn lại nằm trong `BAO_CAO_KIEM_THU.md`.

Game gốc của Jian và 5DPLAY Game Studio.
