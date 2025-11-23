# 🚀 Hướng Dẫn Triển Khai Lên Vercel

Dưới đây là các bước chi tiết để đưa "Cỗ máy in tiền" của bạn lên mạng internet (miễn phí trọn đời).

## Bước 1: Chuẩn bị Git (Làm trên máy tính của bạn)

Mở Terminal (hoặc Command Prompt) tại thư mục dự án `crypto-app` và chạy lần lượt các lệnh sau:

1.  **Khởi tạo kho chứa:**
    ```bash
    git init
    ```

2.  **Thêm toàn bộ code vào kho:**
    ```bash
    git add .
    ```

3.  **Lưu lại phiên bản hiện tại:**
    ```bash
    git commit -m "Initial commit - ABC Terminal Ready"
    ```

    *> Lưu ý: Nếu máy báo lỗi "Please tell me who you are", hãy chạy 2 lệnh sau (thay bằng tên/email của bạn):*
    *   `git config --global user.email "ban@example.com"`
    *   `git config --global user.name "Ten Cua Ban"`

## Bước 2: Đẩy lên GitHub

1.  Đăng nhập vào [GitHub.com](https://github.com).
2.  Bấm dấu **+** ở góc trên bên phải -> Chọn **New repository**.
3.  Đặt tên (ví dụ: `abc-terminal`) -> Bấm **Create repository**.
4.  Copy dòng lệnh xuất hiện ở mục **"…or push an existing repository from the command line"**. Nó sẽ trông giống thế này:
    ```bash
    git remote add origin https://github.com/TEN_CUA_BAN/abc-terminal.git
    git branch -M main
    git push -u origin main
    ```
5.  Dán 3 dòng đó vào Terminal của bạn và Enter.

## Bước 3: Triển khai trên Vercel

1.  Truy cập [Vercel.com](https://vercel.com) và đăng nhập bằng GitHub.
2.  Bấm nút **"Add New..."** -> **Project**.
3.  Bạn sẽ thấy `abc-terminal` trong danh sách -> Bấm **Import**.
4.  Ở màn hình tiếp theo, bấm **Deploy** (Không cần chỉnh sửa gì cả).

## Bước 4: Hoàn tất

*   Đợi khoảng 1-2 phút, màn hình sẽ bắn pháo hoa chúc mừng! 
*   Bấm vào ảnh dự án để lấy đường link (Domain).
*   Gửi link đó cho bạn bè hoặc mở trên điện thoại để theo dõi thị trường mọi lúc mọi nơi.

---
**Lưu ý quan trọng:**
*   Dữ liệu giao dịch (Lịch sử trade, Cấu hình) hiện tại đang lưu trên trình duyệt (LocalStorage). Khi bạn mở trên thiết bị mới, nó sẽ là một trang trắng tinh khôi.
*   Hệ thống **AI Strategy Optimizer** sẽ tự động chạy lại từ đầu trên thiết bị mới để học dữ liệu.
