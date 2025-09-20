(function () {
  var dropzone = document.getElementById("upload-dropzone");
  var fileInput = document.getElementById("file-input");
  var preview = document.getElementById("preview");
  var previewImage = document.getElementById("preview-image");
  var clearButton = document.getElementById("clear-button");
  var analyzeButton = document.getElementById("analyze-button");

  function resetPreview() {
    preview.hidden = true;
    previewImage.src = "";
    analyzeButton.disabled = true;
    fileInput.value = "";
  }

  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      resetPreview();
      return;
    }

    var reader = new FileReader();
    reader.onload = function (event) {
      previewImage.src = event.target.result;
      preview.hidden = false;
      analyzeButton.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  dropzone.addEventListener("dragover", function (event) {
    event.preventDefault();
    dropzone.classList.add("active");
  });

  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("active");
  });

  dropzone.addEventListener("drop", function (event) {
    event.preventDefault();
    dropzone.classList.remove("active");
    var file = event.dataTransfer.files && event.dataTransfer.files[0];
    handleFile(file);
  });

  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    handleFile(file);
  });

  clearButton.addEventListener("click", resetPreview);
})();